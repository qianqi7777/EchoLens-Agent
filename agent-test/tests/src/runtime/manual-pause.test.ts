import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { textMessage, type ToolCallItem } from '../../../../src/core/messages.js';
import type { ModelProvider, ProviderCapabilities, ProviderResult } from '../../../../src/providers/types.js';
import { ReactAgent } from '../../../../src/runtime/resumable-react-agent.js';
import { ToolExecutor } from '../../../../src/runtime/tool-executor.js';
import { ToolRegistry } from '../../../../src/runtime/tool-registry.js';
import { toolSuccess } from '../../../../src/runtime/tool-result.js';
import { SessionRuntime } from '../../../../src/session/session-runtime.js';

const capabilities: ProviderCapabilities = {
  maxContextTokens: 8_192,
  supportsStreaming: false,
  supportsToolCalls: true,
  supportsParallelToolCalls: false,
  supportsStructuredOutput: false,
  supportsPromptCaching: false,
  supportsUsageReporting: false,
};

test('/pause 在工具批次完成后暂停，恢复不重复执行已完成工具', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'echolens-manual-pause-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  let executions = 0;
  let release!: () => void;
  const toolReleased = new Promise<void>((resolve) => { release = resolve; });
  let toolStarted!: () => void;
  const started = new Promise<void>((resolve) => { toolStarted = resolve; });
  const registry = new ToolRegistry();
  registry.register({
    name: 'inspect', description: '测试只读工具', permission: 'workspace.read',
    inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
    async execute(_args, _context) {
      executions += 1;
      toolStarted();
      await toolReleased;
      return toolSuccess('ok', 'inspect 完成');
    },
  });
  let modelCalls = 0;
  const call: ToolCallItem = {
    type: 'tool_call', id: 'inspect-item', callId: 'inspect-call', name: 'inspect', callIndex: 0, arguments: {},
  };
  const model: ModelProvider = {
    model: 'pause-test', capabilities,
    async complete(): Promise<ProviderResult> {
      modelCalls += 1;
      return modelCalls === 1
        ? { output: [textMessage('assistant-tools', 'assistant', ''), call], stopReason: 'tool_calls' }
        : { output: [textMessage('assistant-final', 'assistant', '恢复完成。')], stopReason: 'completed' };
    },
  };
  const agent = new ReactAgent(model, registry, new ToolExecutor(registry), { workspaceRoot: root });
  const session = await SessionRuntime.open(agent, {
    rootDirectory: join(root, 'sessions'), workspaceRoot: root, sessionId: 'pause-session',
  });
  context.after(() => session.close().catch(() => undefined));
  const events: string[] = [];
  const runPromise = session.run('检查状态', undefined, (event) => {
    if (event.payload.type === 'run.paused') events.push(event.payload.reason);
  });
  await started;
  await session.pause();
  release();
  const paused = await runPromise;
  assert.equal(paused.state, 'paused');
  assert.deepEqual(events, ['user_paused']);
  assert.equal(executions, 1);
  const resumed = await session.resume();
  assert.equal(resumed.state, 'completed');
  assert.equal(executions, 1);
  assert.equal(modelCalls, 2);
  assert.equal((await session.store.read()).some((event) => event.payload.type === 'run.paused'
    && event.payload.reason === 'user_paused'), true);
});

test('/pause 没有活动 Turn 时拒绝请求', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'echolens-manual-pause-idle-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const registry = new ToolRegistry();
  const model: ModelProvider = { model: 'idle', capabilities, async complete(): Promise<ProviderResult> {
    return { output: [textMessage('assistant-final', 'assistant', 'ok')], stopReason: 'completed' };
  } };
  const session = await SessionRuntime.open(new ReactAgent(model, registry, new ToolExecutor(registry), { workspaceRoot: root }), {
    rootDirectory: join(root, 'sessions'), workspaceRoot: root, sessionId: 'idle-session',
  });
  context.after(() => session.close().catch(() => undefined));
  await assert.rejects(session.pause(), /没有运行中的 Turn/u);
});
