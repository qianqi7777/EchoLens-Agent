import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createEventRenderer } from '../cli-event-renderer.js';
import {
  isMessageItem,
  messageText,
  textMessage,
  type ConversationItem,
  type ToolCallItem,
  type ToolResultItem,
} from '../core/messages.js';
import type {
  ModelProvider,
  ProviderCapabilities,
  ProviderRequest,
  ProviderResult,
  ProviderStreamEvent,
} from '../providers/types.js';
import type { AgentEvent } from '../session/events.js';
import { ReactAgent } from './react-loop.js';
import { ToolExecutor } from './tool-executor.js';
import { ToolRegistry } from './tool-registry.js';
import { registerWorkspaceTools } from './workspace-tools.js';

class ScriptedModel implements ModelProvider {
  readonly model = 'test-model';
  readonly capabilities: ProviderCapabilities = {
    maxContextTokens: 8_192,
    supportsStreaming: false,
    supportsToolCalls: true,
    supportsParallelToolCalls: true,
    supportsStructuredOutput: true,
    supportsPromptCaching: false,
    supportsUsageReporting: false,
  };
  private turn = 0;

  async complete(_request: ProviderRequest): Promise<ProviderResult> {
    this.turn += 1;
    if (this.turn === 1) {
      const call: ToolCallItem = {
        type: 'tool_call',
        id: 'item-call-1',
        callId: 'call-1',
        name: 'read_file',
        arguments: { path: 'hello.ts' },
        callIndex: 0,
      };
      return {
        output: [textMessage('assistant-1', 'assistant', ''), call],
        stopReason: 'tool_calls',
      };
    }
    return {
      output: [textMessage('assistant-2', 'assistant', '已读取目标文件。')],
      stopReason: 'completed',
    };
  }
}

test('ReactAgent completes a tool round trip', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'agent-runtime-'));
  await writeFile(join(workspace, 'hello.ts'), 'export const hello = true;\n');
  const registry = new ToolRegistry();
  registerWorkspaceTools(registry);
  const events: AgentEvent[] = [];
  const result = await new ReactAgent(
    new ScriptedModel(),
    registry,
    new ToolExecutor(registry),
    { workspaceRoot: workspace },
  ).run('读取 hello.ts', [], undefined, { onEvent: (event) => { events.push(event); } });

  assert.equal(result.answer, '已读取目标文件。');
  assert.equal(result.trace.some((item) => item.type === 'tool'), true);
  assert.equal(result.items.some((item) => item.type === 'tool_call' && item.callId === 'call-1'), true);
  assert.equal(result.items.some((item) => item.type === 'tool_result' && item.output.content.includes('hello')), true);
  const finalMessage = result.items.findLast(
    (item) => isMessageItem(item) && item.role === 'assistant' && messageText(item).length > 0,
  );
  assert.ok(finalMessage && isMessageItem(finalMessage));
  assert.equal(messageText(finalMessage), result.answer);
  // 协议不变量：持久化的对话项不得残留 Chat Completions 线格式字段（tool_calls、
  // tool_call_id），否则换协议重放时会把 Provider 特有字段泄漏进后续请求。
  assert.doesNotMatch(JSON.stringify(result.items), /tool_calls|tool_call_id/);
  assert.equal(events.some((event) => event.payload.type === 'workspace.file.observed'
    && event.payload.operation === 'read'
    && event.payload.path === 'hello.ts'
    && event.payload.callId === 'call-1'), true);
  const toolLogs: string[] = [];
  const toolRenderer = createEventRenderer({ write: () => {}, log: (value) => { toolLogs.push(value); } });
  events.forEach(toolRenderer.onEvent);
  assert.equal(toolLogs.some((line) => line === '[tool] read_file started'), true);
  assert.equal(toolLogs.some((line) => /^\[tool\] read_file ok \d+ms$/u.test(line)), true);
});

test('ReactAgent records a pure text response as the final assistant item', async () => {
  const provider: ModelProvider = {
    model: 'text-only',
    capabilities: new ScriptedModel().capabilities,
    async complete(): Promise<ProviderResult> {
      return { output: [textMessage('assistant-final', 'assistant', '完成。')], stopReason: 'completed' };
    },
  };
  const registry = new ToolRegistry();
  const result = await new ReactAgent(provider, registry, new ToolExecutor(registry), {
    workspaceRoot: process.cwd(),
  }).run('只回答');

  assert.equal(result.answer, '完成。');
  assert.equal(result.items.at(-1)?.type, 'message');
});

test('workspace tools reject paths outside the workspace', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'agent-runtime-'));
  const registry = new ToolRegistry();
  registerWorkspaceTools(registry);
  const executor = new ToolExecutor(registry);
  // 安全攻击样本：`..\` 用反斜杠分隔符尝试逃出工作区；校验必须拒绝，
  // 不能把反斜杠路径当作普通字面文件名放行。
  const result = await executor.invoke('read_file', { path: '..\\outside.txt' }, {
    workspaceRoot: workspace,
    allowedPermissions: new Set(['workspace.read']),
    signal: new AbortController().signal,
  });

  assert.equal(result.status, 'denied');
  assert.equal(result.error?.code, 'permission_denied');
  assert.deepEqual(result.error?.data, { pathPolicyCode: 'path_outside_workspace' });
});

test('ReactAgent keeps complete recent turns, unique IDs, and provider capability boundaries', async () => {
  const requests: ProviderRequest[] = [];
  const provider: ModelProvider = {
    model: 'history-model',
    capabilities: { ...new ScriptedModel().capabilities, supportsToolCalls: false },
    async complete(request: ProviderRequest): Promise<ProviderResult> {
      requests.push(request);
      return {
        output: [textMessage(`assistant-${requests.length}`, 'assistant', 'ok')],
        stopReason: 'completed',
      };
    },
  };
  const calls = Array.from({ length: 6 }, (_, index): ToolCallItem => ({
    type: 'tool_call',
    id: `call-item-${index}`,
    callId: `call-${index}`,
    name: 'read_file',
    arguments: { path: `${index}.ts` },
    callIndex: index,
  }));
  const results = calls.map((call, index): ToolResultItem => ({
    type: 'tool_result',
    id: `result-${index}`,
    callId: call.callId,
    toolName: call.name,
    status: 'ok',
    output: {
      id: `context-${index}`,
      kind: 'tool_output',
      content: 'ok',
      source: { type: 'tool', toolCallId: call.callId, toolName: call.name },
      trust: 'untrusted',
      redactions: [],
    },
    summary: 'ok',
    evidenceIds: [],
  }));
  const history: ConversationItem[] = [
    textMessage('old-user', 'user', 'old'),
    textMessage('old-assistant', 'assistant', 'old answer'),
    textMessage('recent-user', 'user', 'recent'),
    textMessage('recent-assistant-tools', 'assistant', ''),
    ...calls,
    ...results,
    textMessage('recent-assistant-final', 'assistant', 'recent answer'),
  ];
  const registry = new ToolRegistry();
  registerWorkspaceTools(registry);
  const agent = new ReactAgent(provider, registry, new ToolExecutor(registry), {
    workspaceRoot: process.cwd(),
    maxHistoryTurns: 2,
  });

  const first = await agent.run('first', history);
  assert.equal(requests[0]?.items.some((item) => item.id === 'old-user'), false);
  assert.equal(requests[0]?.items.some((item) => item.id === 'recent-user'), true);
  assert.equal(requests[0]?.items.some((item) => item.id.startsWith('instruction-message:')), true);
  assert.equal(requests[0]?.tools, undefined);
  const replayedCalls = new Set(requests[0]?.items
    .filter((item): item is ToolCallItem => item.type === 'tool_call')
    .map((item) => item.callId));
  for (const result of requests[0]?.items.filter(
    (item): item is ToolResultItem => item.type === 'tool_result'
  ) ?? []) {
    assert.equal(replayedCalls.has(result.callId), true, result.callId);
  }

  await agent.run('second', first.items);
  const generatedUserIds = requests.map((request) => request.items.findLast(
    (item) => item.type === 'message' && item.role === 'user',
  )?.id);
  assert.equal(generatedUserIds.every(Boolean), true);
  assert.notEqual(generatedUserIds[0], generatedUserIds[1]);
});

test('ReactAgent marks non-completed stop reasons as degraded', async () => {
  const registry = new ToolRegistry();
  const provider: ModelProvider = {
    model: 'truncated-model',
    capabilities: { ...new ScriptedModel().capabilities, supportsStructuredOutput: false },
    async complete(): Promise<ProviderResult> {
      return {
        output: [textMessage('partial', 'assistant', 'partial answer')],
        stopReason: 'truncated',
      };
    },
  };
  const result = await new ReactAgent(provider, registry, new ToolExecutor(registry), {
    workspaceRoot: process.cwd(),
  }).run('answer');

  assert.equal(result.answer, 'partial answer');
  assert.equal(result.degraded, true);
  assert.equal(result.trace.some((item) => item.type === 'warning'), true);
});

test('ReactAgent projects streaming text and usage into Runtime events', async () => {
  const registry = new ToolRegistry();
  const provider: ModelProvider = {
    model: 'stream-model',
    capabilities: {
      ...new ScriptedModel().capabilities,
      supportsStreaming: true,
      supportsStructuredOutput: false,
    },
    async complete(): Promise<ProviderResult> {
      throw new Error('支持流式时不应调用 complete');
    },
    async *stream(): AsyncGenerator<ProviderStreamEvent> {
      yield { type: 'response.started', requestId: 'stream-request' };
      yield { type: 'transport.retry', attempt: 2, delayMs: 10, code: 'rate_limit' };
      yield { type: 'output_text.delta', delta: '流式' };
      yield { type: 'output_text.delta', delta: '完成' };
      yield {
        type: 'response.completed',
        result: {
          output: [textMessage('stream-final', 'assistant', '流式完成')],
          stopReason: 'completed',
          usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 },
          requestId: 'stream-request',
          transport: { attempts: 1, retries: 0, elapsedMs: 12 },
        },
      };
    },
  };
  const events: import('../session/events.js').AgentEvent[] = [];
  const result = await new ReactAgent(provider, registry, new ToolExecutor(registry), {
    workspaceRoot: process.cwd(),
  }).run('流式回答', [], undefined, { onEvent: (event) => { events.push(event); } });

  assert.equal(result.answer, '流式完成');
  assert.equal(events.filter((event) => event.payload.type === 'model.output.delta')
    .map((event) => event.payload.type === 'model.output.delta' ? event.payload.delta : '')
    .join(''), '流式完成');
  assert.equal(events.some((event) => event.payload.type === 'usage.recorded'
    && event.payload.usage.totalTokens === 7), true);
  const writes: string[] = [];
  const logs: string[] = [];
  const renderer = createEventRenderer({
    write: (value) => { writes.push(value); },
    log: (value) => { logs.push(value); },
  });
  events.forEach(renderer.onEvent);
  renderer.finish();
  assert.equal(writes.join(''), '流式完成\n');
  assert.equal(logs.includes('[model] step 1 started'), true);
  assert.equal(logs.includes('[model] retry 2 (rate_limit)'), true);

  renderer.onEvent({
    version: 1,
    eventId: 'tool-without-start',
    sessionId: 'renderer-test',
    turnId: 'renderer-turn',
    runId: 'renderer-run',
    seq: 1,
    timestamp: new Date(0).toISOString(),
    payload: {
      type: 'model.output.delta',
      step: 0,
      delta: 'partial',
    },
  });
  renderer.onEvent({
    version: 1,
    eventId: 'denied-tool',
    sessionId: 'renderer-test',
    turnId: 'renderer-turn',
    runId: 'renderer-run',
    seq: 2,
    timestamp: new Date(0).toISOString(),
    payload: {
      type: 'tool.completed',
      callId: 'denied-call',
      toolName: 'guarded_tool',
      callIndex: 0,
      status: 'denied',
      elapsedMs: 0,
      evidenceIds: [],
    },
  });
  assert.equal(writes.join('').endsWith('partial\n'), true);
  assert.equal(logs.at(-1), '[tool] guarded_tool denied 0ms');
});
