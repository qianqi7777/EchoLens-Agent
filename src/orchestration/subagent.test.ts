import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { textMessage } from '../core/messages.js';
import type { ModelProvider, ProviderRequest } from '../providers/types.js';
import { toolSuccess } from '../runtime/tool-result.js';
import { ToolRegistry } from '../runtime/tool-registry.js';
import type { TaskWorkspaceAllocator } from './workspace-allocator.js';
import { LifecycleHookRunner } from './lifecycle-hooks.js';
import {
  BUILTIN_SUBAGENT_PROFILES,
  createWorkspaceBoundSubagentRegistry,
  SubagentOrchestrator,
} from './subagent.js';

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
      id: 'lease', mode, root,
      changedFiles: async () => [], cleanup: async () => undefined,
    };
    },
  };
  const result = await new SubagentOrchestrator(model, registry, root, allocator).run({
    profile: 'explore', objective: 'inspect symbols', workspaceMode: 'worktree',
  });
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
  assert.equal('items' in result, false);
});

test('仓库级 Hook 未显式信任时跳过，受信 Hook 只能观察克隆事件', async () => {
  let observed = '';
  const runner = new LifecycleHookRunner({ trustedRepositoryHooks: new Set(['trusted']) });
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
      execute: async () => toolSuccess('ok', 'ok'),
    });
  }
  return registry;
}
