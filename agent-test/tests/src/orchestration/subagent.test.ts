import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { textMessage, type ToolCallItem } from '../../../../src/core/messages.js';
import type { ModelProvider, ProviderRequest } from '../../../../src/providers/types.js';
import { toolSuccess } from '../../../../src/runtime/tool-result.js';
import { ToolRegistry } from '../../../../src/runtime/tool-registry.js';
import type { TaskWorkspaceAllocator } from '../../../../src/orchestration/workspace-allocator.js';
import { LifecycleHookRunner } from '../../../../src/orchestration/lifecycle-hooks.js';
import type { AgentEvent } from '../../../../src/session/events.js';
import { SubagentBackgroundService } from '../../../../src/orchestration/subagent-background.js';
import { PersistentTaskQueue } from '../../../../src/orchestration/task-queue.js';
import {
  BUILTIN_SUBAGENT_PROFILES,
  createWorkspaceBoundSubagentRegistry,
  SubagentOrchestrator,
  type SubagentResult,
} from '../../../../src/orchestration/subagent.js';

test('Explore 子 Agent 只看到白名单工具，父级只收到结构化摘要和证据', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'echolens-subagent-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const registry = registryWithTools([
    'read_file', 'grep', 'list_files', 'outline_file', 'find_symbols',
    'go_to_definition', 'find_references', 'get_diagnostics', 'shell_exec',
  ]);
  const model = new RecordingModel();
  let allocatedMode = '';
  const allocator: TaskWorkspaceAllocator = {
    allocate: async (_workspaceRoot, mode) => {
      allocatedMode = mode;
      return {
      id: 'lease', mode, root, workspaceKey: root,
      changedFiles: async () => [], cleanup: async () => undefined,
    };
    },
  };
  const result = await new SubagentOrchestrator(model, registry, root, allocator).run({
    profile: 'explore', objective: 'inspect symbols', workspaceMode: 'worktree',
  });
  // 验证信任边界：源注册表含 shell_exec(process.exec)，但 explore 子 Agent 模型可见的工具列表不得包含它，
  // 且父级只收到结构化 summary/evidence，不外泄 items 原始轨迹。
  const names = model.requests[0]?.tools?.map((tool) => tool.name).sort() ?? [];
  assert.equal(names.includes('shell_exec'), false);
  assert.deepEqual(names, [
    'find_references', 'find_symbols', 'get_diagnostics', 'go_to_definition',
    'grep', 'list_files', 'outline_file', 'read_file',
  ]);
  assert.equal(result.state, 'completed');
  assert.equal(result.workspaceMode, 'worktree');
  assert.equal(allocatedMode, 'worktree');
  assert.equal(result.summary, 'explored');
  assert.deepEqual(result.changedFiles, []);
  assert.deepEqual(result.usage, {
    inputTokens: 20, outputTokens: 10, cachedTokens: 0, modelSteps: 2, toolCalls: 1,
  });
  assert.deepEqual(result.estimatedCost, { unknown: true });
  assert.equal('items' in result, false);
});

test('仓库级 Hook 未显式信任时跳过，受信 Hook 只能观察克隆事件', async () => {
  let observed = '';
  const runner = new LifecycleHookRunner({ trustedRepositoryHooks: new Set(['trusted']) });
  // untrusted 仓库 Hook 若被执行会抛错，验证未显式信任的仓库 Hook 被跳过；受信 Hook 只接收只读克隆事件。
  runner.register({
    id: 'untrusted', trust: 'repository', stages: new Set(['tool']),
    handle: async () => { throw new Error('must not run'); },
  });
  runner.register({
    id: 'trusted', trust: 'repository', stages: new Set(['tool']),
    handle: async (event) => { observed = event.payload.type; },
  });
  const results = await runner.observe({
    version: 1, eventId: 'e', sessionId: 's', seq: 1, timestamp: '2026-08-29T00:00:00.000Z',
    payload: { type: 'tool.started', callId: 'c', toolName: 'read_file', callIndex: 0 },
  });
  assert.equal(results.find((item) => item.hookId === 'untrusted')?.status, 'skipped');
  assert.equal(results.find((item) => item.hookId === 'trusted')?.status, 'completed');
  assert.equal(observed, 'tool.started');
});

test('代码智能工具绑定子 Agent 租约目录而不是主工作区', async (t) => {
  const sourceRoot = await mkdtemp(join(tmpdir(), 'echolens-subagent-source-'));
  const leaseRoot = await mkdtemp(join(tmpdir(), 'echolens-subagent-lease-'));
  t.after(() => Promise.all([
    rm(sourceRoot, { recursive: true, force: true }),
    rm(leaseRoot, { recursive: true, force: true }),
  ]));
  // 两个 Fixture 分别含 RootOnly/LeaseOnly 符号：证明 find_symbols 的索引绑定租约目录而非主工作区。
  await writeFile(join(sourceRoot, 'sample.ts'), 'export function RootOnly() {}\n');
  await writeFile(join(leaseRoot, 'sample.ts'), 'export function LeaseOnly() {}\n');
  const sourceRegistry = registryWithTools([
    'read_file', 'grep', 'list_files', 'outline_file', 'find_symbols',
    'go_to_definition', 'find_references', 'get_diagnostics',
  ]);
  const scoped = await createWorkspaceBoundSubagentRegistry(
    leaseRoot,
    BUILTIN_SUBAGENT_PROFILES.explore,
    sourceRegistry,
  );
  t.after(() => scoped.close());
  const context = {
    workspaceRoot: leaseRoot,
    allowedPermissions: new Set(['workspace.read'] as const),
    signal: new AbortController().signal,
  };
  const leaseResult = await scoped.registry.get('find_symbols').execute({ query: 'LeaseOnly' }, context);
  const sourceResult = await scoped.registry.get('find_symbols').execute({ query: 'RootOnly' }, context);
  assert.equal(leaseResult.status, 'ok');
  assert.match(leaseResult.content, /LeaseOnly/u);
  assert.doesNotMatch(sourceResult.content, /RootOnly/u);
});

test('观察型 Hook 隔离事件副本、超时与异常，不能中断后续 Hook', async () => {
  const runner = new LifecycleHookRunner({ timeoutMs: 10 });
  const event: AgentEvent = {
    version: 1, eventId: 'event', sessionId: 'session', seq: 1,
    timestamp: '2026-09-26T00:00:00.000Z',
    payload: { type: 'tool.started', callId: 'original', toolName: 'read_file', callIndex: 0 },
  };
  let observed = '';
  runner.register({
    id: 'mutates-copy', trust: 'builtin', stages: new Set(['tool']),
    handle: async (copy) => { (copy.payload as { callId: string }).callId = 'changed'; },
  });
  runner.register({
    id: 'throws', trust: 'user', stages: new Set(['tool']),
    handle: async () => { throw new Error('observer failed'); },
  });
  runner.register({
    id: 'times-out', trust: 'user', stages: new Set(['tool']),
    handle: async () => new Promise<void>(() => undefined),
  });
  runner.register({
    id: 'still-runs', trust: 'builtin', stages: new Set(['tool']),
    handle: async (copy) => { observed = (copy.payload as { callId: string }).callId; },
  });
  const results = await runner.observe(event);
  assert.deepEqual(results.map((item) => item.status), ['completed', 'failed', 'timeout', 'completed']);
  assert.equal((event.payload as { callId: string }).callId, 'original');
  assert.equal(observed, 'original');
});

test('未绑定工作区的 Hook Runner 保持空结果，拒绝信任变更及无效注册', async () => {
  const runner = new LifecycleHookRunner();
  const event: AgentEvent = {
    version: 1, eventId: 'event', sessionId: 'session', seq: 1,
    timestamp: '2026-09-26T00:00:00.000Z', payload: { type: 'turn.started', userMessage: 'hello' },
  };
  assert.deepEqual(await runner.observe(event), []);
  assert.deepEqual(await runner.run({ version: 1, hookEventName: 'SessionStart', sessionId: 'session', cwd: '.' }),
    { decision: 'continue', contexts: [], results: [] });
  assert.deepEqual(runner.hookStatus(), []);
  assert.deepEqual(await runner.reloadCommandHooks(), runner.hookSummary());
  await assert.rejects(runner.trustProjectHooks('all'), /未绑定工作区/u);
  await assert.rejects(runner.revokeProjectHooks('all'), /未绑定工作区/u);
  assert.throws(() => new LifecycleHookRunner({ timeoutMs: 1 }), /timeoutMs/u);
  const valid = { id: 'valid', trust: 'builtin' as const, stages: new Set(['turn'] as const), handle: async () => undefined };
  runner.register(valid);
  assert.throws(() => runner.register(valid), /已注册/u);
  assert.throws(() => runner.register({ ...valid, id: '../bad' }), /ID 无效/u);
  assert.throws(() => runner.register({ ...valid, id: 'bad-trust', trust: 'unknown' as 'builtin' }), /trust 无效/u);
  assert.throws(() => runner.register({ ...valid, id: 'bad-stage', stages: new Set(['unknown' as 'turn']) }), /stage 无效/u);
});

test('后台子 Agent 映射完成与审批状态，并在恢复后保留使用量证据', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'echolens-subagent-background-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const queue = new PersistentTaskQueue(join(root, 'tasks.json'));
  const requests: string[] = [];
  let paused = true;
  const orchestrator = {
    run: async (request: { objective: string }): Promise<SubagentResult> => {
      requests.push(request.objective);
      return subagentResult(paused ? 'paused' : 'completed');
    },
  } as unknown as SubagentOrchestrator;
  const service = new SubagentBackgroundService(queue, orchestrator, undefined, undefined, (objective) => `[context] ${objective}`);
  t.after(() => service.close());
  service.setConcurrency(1);

  const task = await service.enqueue('explore', 'inspect', 'sandbox', { source: 'test' });
  await waitForTaskState(queue, task.id, 'waiting_approval');
  const waiting = await queue.get(task.id);
  assert.equal(waiting?.waitingReason, '子 Agent 等待审批');
  assert.equal(waiting?.result?.summary, 'subagent summary');
  assert.deepEqual(waiting?.result?.usage, { inputTokens: 2, outputTokens: 1, modelSteps: 1, toolCalls: 0 });
  assert.deepEqual(requests, ['[context] inspect']);
  assert.equal((await service.workerStatus()).running, 0);
  assert.equal((await service.list()).length, 1);

  paused = false;
  const resumed = await service.resume(task.id);
  assert.equal(resumed.state, 'pending');
  await waitForTaskState(queue, task.id, 'completed');
  assert.deepEqual(requests, ['[context] inspect', '[context] inspect']);
  assert.deepEqual((await queue.get(task.id))?.result?.evidenceIds, ['evidence:subagent']);
  await assert.rejects(service.resume('missing-task'), /后台任务不存在/u);
});

test('后台子 Agent 失败与取消不会伪装为已完成', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'echolens-subagent-background-failure-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const queue = new PersistentTaskQueue(join(root, 'tasks.json'));
  const orchestrator = {
    run: async (request: { objective: string }): Promise<SubagentResult> => subagentResult(request.objective === 'cancelled' ? 'cancelled' : 'failed'),
  } as unknown as SubagentOrchestrator;
  const service = new SubagentBackgroundService(queue, orchestrator);
  t.after(() => service.close());

  const failed = await service.enqueue('review', 'failed');
  await waitForTaskState(queue, failed.id, 'failed');
  assert.equal((await queue.get(failed.id))?.errorCode, 'subagent_failed');
  assert.equal((await queue.get(failed.id))?.result, undefined);

  const cancelled = await service.enqueue('review', 'cancelled');
  await waitForTaskState(queue, cancelled.id, 'failed');
  assert.equal((await queue.get(cancelled.id))?.attempts, 2);
  assert.equal((await queue.get(cancelled.id))?.errorCode, 'subagent_cancelled');
  const terminal = await service.cancel(cancelled.id);
  assert.equal(terminal.state, 'failed');
});

function subagentResult(state: SubagentResult['state']): SubagentResult {
  const usage = { inputTokens: 2, outputTokens: 1, modelSteps: 1, toolCalls: 0 };
  return {
    schemaVersion: 1, profile: 'explore', workspaceMode: 'sandbox', state,
    summary: 'subagent summary', changedFiles: [], tests: [], unresolved: [], evidenceIds: ['evidence:subagent'],
    usage, metrics: usage, estimatedCost: { unknown: true },
  };
}

async function waitForTaskState(queue: PersistentTaskQueue, taskId: string, expected: string): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    if ((await queue.get(taskId))?.state === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`后台任务未进入 ${expected} 状态`);
}

class RecordingModel implements ModelProvider {
  readonly model = 'test-model';
  readonly capabilities = {
    maxContextTokens: 32_000,
    supportsStreaming: false,
    supportsToolCalls: true,
    supportsParallelToolCalls: true,
    supportsStructuredOutput: true,
    supportsPromptCaching: false,
    supportsUsageReporting: true,
  };
  readonly requests: ProviderRequest[] = [];

  async complete(request: ProviderRequest) {
    this.requests.push(request);
    if (this.requests.length === 1) {
      const call: ToolCallItem = {
        type: 'tool_call', id: 'explore-call-item', callId: 'explore-call', name: 'list_files', arguments: {}, callIndex: 0,
      };
      return {
        output: [call],
        stopReason: 'tool_calls' as const,
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      };
    }
    return {
      output: [textMessage('answer', 'assistant', JSON.stringify({
        answer: 'explored', changes: ['model-claimed.ts'], verification: [], unresolved: [], warnings: [],
      }))],
      stopReason: 'completed' as const,
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    };
  }
}

function registryWithTools(names: string[]): ToolRegistry {
  const registry = new ToolRegistry();
  for (const name of names) {
    registry.register({
      name,
      description: name,
      permission: name === 'shell_exec' ? 'process.exec' : 'workspace.read',
      effect: name === 'shell_exec' ? 'process' : 'read',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      execute: async () => toolSuccess('ok', 'ok', ['test:subagent-evidence']),
    });
  }
  return registry;
}
