import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  textMessage,
  type ToolCallItem,
  type ToolResultItem,
} from '../core/messages.js';
import { systemPolicyMessage } from '../core/system-policy.js';
import type {
  ModelProvider,
  ProviderCapabilities,
  ProviderRequest,
  ProviderResult,
} from '../providers/types.js';
import { ReactAgent } from '../runtime/react-loop.js';
import { ToolExecutor } from '../runtime/tool-executor.js';
import { ToolRegistry } from '../runtime/tool-registry.js';
import { toolSuccess } from '../runtime/tool-result.js';
import { JsonlEventStore } from './jsonl-event-store.js';
import { SessionRuntime } from './session-runtime.js';

const capabilities: ProviderCapabilities = {
  maxContextTokens: 8_192,
  supportsStreaming: false,
  supportsToolCalls: true,
  supportsParallelToolCalls: true,
  supportsStructuredOutput: false,
  supportsPromptCaching: false,
  supportsUsageReporting: true,
};

test('工具执行后退出可从同一 Turn 恢复且不重复工具', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'echolens-session-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const registry = new ToolRegistry();
  let executions = 0;
  registry.register({
    name: 'inspect',
    description: '测试只读工具',
    permission: 'workspace.read',
    inputSchema: {
      type: 'object',
      properties: { value: { type: 'integer' } },
      required: ['value'],
      additionalProperties: false,
    },
    async execute(args) {
      executions += 1;
      return toolSuccess(String(args.value), `inspect ${args.value}`);
    },
  });

  const firstAgent = new ReactAgent(
    toolCallingProvider(),
    registry,
    new ToolExecutor(registry),
    { workspaceRoot: root, maxSteps: 1 },
  );
  const firstSession = await SessionRuntime.open(firstAgent, {
    rootDirectory: join(root, 'sessions'),
    workspaceRoot: root,
    sessionId: 'resume-session',
    storeOptions: { flushEachEvent: false },
  });
  // 首次 run 在工具批次后因 step 预算暂停，事件全部落盘。
  const paused = await firstSession.run('检查两个值');
  assert.equal(paused.state, 'paused');
  assert.equal(paused.turnId, paused.checkpoint.turnId);
  assert.equal(executions, 2);
  await firstSession.close();

  const requests: ProviderRequest[] = [];
  const resumedAgent = new ReactAgent(
    finalProvider(requests),
    registry,
    new ToolExecutor(registry),
    { workspaceRoot: root, maxSteps: 1 },
  );
  const resumedSession = await SessionRuntime.open(resumedAgent, {
    rootDirectory: join(root, 'sessions'),
    workspaceRoot: root,
    sessionId: 'resume-session',
    storeOptions: { flushEachEvent: false },
  });
  // 恢复阶段不重新执行工具：输入由存储中的 tool.completed 重建，executions 保持 2。
  const completed = await resumedSession.resume();

  assert.equal(completed.state, 'completed');
  assert.equal(completed.turnId, paused.turnId);
  assert.notEqual(completed.runId, paused.runId);
  assert.equal(executions, 2);
  assert.equal(requests[0]?.items.filter((item) => item.type === 'tool_result').length, 2);
  const events = await resumedSession.store.read();
  assert.deepEqual(events.map((event) => event.seq), events.map((_, index) => index + 1));
  assert.equal(events.some((event) => event.payload.type === 'run.paused'), true);
  assert.equal(events.some((event) => event.payload.type === 'run.completed'), true);
  await resumedSession.close();
});

test('并行批次中途退出后从 tool.completed 恢复且只执行未完成工具', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'echolens-session-partial-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const sessionRoot = join(root, 'sessions');
  const calls: ToolCallItem[] = [0, 1].map((index) => ({
    type: 'tool_call',
    id: `item-${index}`,
    callId: `call-${index}`,
    name: 'inspect',
    arguments: { value: index },
    callIndex: index,
  }));
  const checkpoint = {
    version: 1 as const,
    sessionId: 'partial-session',
    turnId: 'partial-turn',
    runId: 'first-run',
    step: 0,
    phase: 'tools' as const,
    toolCallsUsed: 0,
    state: 'running' as const,
    items: [
      systemPolicyMessage(),
      textMessage('user-partial', 'user', '检查两个值'),
      textMessage('assistant-partial', 'assistant', ''),
      ...calls,
    ],
  };
  const recoveredResult: ToolResultItem = {
    type: 'tool_result',
    id: 'result-0',
    callId: 'call-0',
    toolName: 'inspect',
    status: 'ok',
    output: {
      id: 'output-0',
      kind: 'tool_output',
      content: '0',
      source: { type: 'tool', toolCallId: 'call-0', toolName: 'inspect' },
      trust: 'untrusted',
      contentHash: 'stored-result',
      redactions: [],
    },
    summary: 'inspect 0',
    evidenceIds: [],
  };
  // 手工预置检查点与 call-0 的 tool.completed，构造“并行批次写了一半”的存储快照。
  const firstStore = new JsonlEventStore(sessionRoot, 'partial-session', { flushEachEvent: false });
  await firstStore.append({ payload: { type: 'session.created', workspaceRoot: root } });
  await firstStore.append({
    turnId: checkpoint.turnId,
    runId: checkpoint.runId,
    payload: { type: 'checkpoint.saved', checkpoint },
  });
  await firstStore.append({
    turnId: checkpoint.turnId,
    runId: checkpoint.runId,
    payload: {
      type: 'tool.completed',
      callId: 'call-0',
      toolName: 'inspect',
      callIndex: 0,
      status: 'ok',
      elapsedMs: 1,
      evidenceIds: [],
      result: recoveredResult,
    },
  });
  await firstStore.close();

  const registry = new ToolRegistry();
  const executedValues: number[] = [];
  registry.register({
    name: 'inspect',
    description: '测试只读工具',
    permission: 'workspace.read',
    effect: 'read',
    inputSchema: {
      type: 'object',
      properties: { value: { type: 'integer' } },
      required: ['value'],
      additionalProperties: false,
    },
    async execute(args) {
      executedValues.push(args.value as number);
      return toolSuccess(String(args.value), `inspect ${args.value}`);
    },
  });
  const requests: ProviderRequest[] = [];
  const session = await SessionRuntime.open(
    new ReactAgent(finalProvider(requests), registry, new ToolExecutor(registry), {
      workspaceRoot: root,
      maxSteps: 2,
    }),
    {
      rootDirectory: sessionRoot,
      workspaceRoot: root,
      sessionId: 'partial-session',
      storeOptions: { flushEachEvent: false },
    },
  );
  const completed = await session.resume();
  await session.close();

  assert.equal(completed.state, 'completed');
  assert.deepEqual(executedValues, [1]);
  assert.deepEqual(
    requests[0]?.items.filter((item) => item.type === 'tool_result').map((item) => item.callId),
    ['call-0', 'call-1'],
  );
});

test('取消 Turn 后 Event Store 保持完整并可重新打开', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'echolens-session-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const registry = new ToolRegistry();
  const provider: ModelProvider = {
    model: 'never-called',
    capabilities,
    async complete(): Promise<ProviderResult> {
      throw new Error('预取消信号不应进入 Provider');
    },
  };
  const session = await SessionRuntime.open(
    new ReactAgent(provider, registry, new ToolExecutor(registry), {
      workspaceRoot: root,
    }),
    {
      rootDirectory: join(root, 'sessions'),
      workspaceRoot: root,
      sessionId: 'cancel-session',
      storeOptions: { flushEachEvent: false },
    },
  );
  const controller = new AbortController();
  controller.abort('test-cancel');
  const result = await session.run('取消', controller.signal);
  assert.equal(result.state, 'cancelled');
  await session.close();

  const reopened = new JsonlEventStore(join(root, 'sessions'), 'cancel-session', {
    flushEachEvent: false,
  });
  const events = await reopened.read();
  assert.equal(events.at(-1)?.payload.type, 'run.cancelled');
  assert.deepEqual(events.map((event) => event.seq), events.map((_, index) => index + 1));
  await reopened.close();
});

test('运行中的 steering 在同一 Turn 下一模型步骤生效并持久化', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'echolens-session-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const registry = new ToolRegistry();
  let releaseTool!: () => void;
  let announceStarted!: () => void;
  const toolStarted = new Promise<void>((resolve) => { announceStarted = resolve; });
  const toolRelease = new Promise<void>((resolve) => { releaseTool = resolve; });
  registry.register({
    name: 'wait_read',
    description: '等待 steering 的只读工具',
    permission: 'workspace.read',
    effect: 'read',
    inputSchema: { type: 'object', additionalProperties: false },
    async execute() {
      announceStarted();
      await toolRelease;
      return toolSuccess('done', 'wait done');
    },
  });
  const requests: ProviderRequest[] = [];
  let modelTurn = 0;
  const provider: ModelProvider = {
    model: 'steering-provider',
    capabilities,
    async complete(request): Promise<ProviderResult> {
      requests.push(request);
      modelTurn += 1;
      if (modelTurn === 1) {
        return {
          output: [textMessage('assistant-wait', 'assistant', ''), {
            type: 'tool_call',
            id: 'wait-item',
            callId: 'wait-call',
            name: 'wait_read',
            arguments: {},
            callIndex: 0,
          }],
          stopReason: 'tool_calls',
        };
      }
      return {
        output: [textMessage('assistant-steered', 'assistant', '已采用新方向。')],
        stopReason: 'completed',
      };
    },
  };
  const session = await SessionRuntime.open(
    new ReactAgent(provider, registry, new ToolExecutor(registry), { workspaceRoot: root }),
    {
      rootDirectory: join(root, 'sessions'),
      workspaceRoot: root,
      sessionId: 'steering-session',
      storeOptions: { flushEachEvent: false },
    },
  );

  // 用 Promise 卡住工具执行，制造 run 已进入工具阶段但未返回的竞态窗口，再注入 steering。
  const running = session.run('原始方向');
  await toolStarted;
  await session.steer('改为检查新的方向');
  releaseTool();
  const result = await running;
  const events = await session.store.read();
  await session.close();

  assert.equal(result.state, 'completed');
  assert.equal(requests[1]?.items.some((item) => item.type === 'message'
    && item.role === 'user'
    && item.content.some((part) => part.text === '改为检查新的方向')), true);
  const steering = events.find((event) => event.payload.type === 'turn.steered');
  assert.equal(steering?.turnId, result.turnId);
});

function toolCallingProvider(): ModelProvider {
  return {
    model: 'tool-caller',
    capabilities,
    async complete(): Promise<ProviderResult> {
      const calls: ToolCallItem[] = [0, 1].map((index) => ({
        type: 'tool_call',
        id: `item-${index}`,
        callId: `call-${index}`,
        name: 'inspect',
        arguments: { value: index },
        callIndex: index,
      }));
      return { output: [textMessage('assistant-tools', 'assistant', ''), ...calls], stopReason: 'tool_calls' };
    },
  };
}

function finalProvider(requests: ProviderRequest[]): ModelProvider {
  return {
    model: 'final-provider',
    capabilities,
    async complete(request): Promise<ProviderResult> {
      requests.push(request);
      return {
        output: [textMessage('assistant-final', 'assistant', '恢复完成。')],
        stopReason: 'completed',
      };
    },
  };
}
