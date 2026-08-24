import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  isMessageItem,
  messageText,
  textMessage,
  type ConversationItem,
  type ToolCallItem,
  type ToolResultItem,
} from '../core/messages.js';
import type { ModelProvider, ProviderCapabilities, ProviderRequest, ProviderResult } from '../providers/types.js';
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
  const result = await new ReactAgent(
    new ScriptedModel(),
    registry,
    new ToolExecutor(registry),
    { workspaceRoot: workspace },
  ).run('读取 hello.ts');

  assert.equal(result.answer, '已读取目标文件。');
  assert.equal(result.trace.some((item) => item.type === 'tool'), true);
  assert.equal(result.items.some((item) => item.type === 'tool_call' && item.callId === 'call-1'), true);
  assert.equal(result.items.some((item) => item.type === 'tool_result' && item.output.content.includes('hello')), true);
  const finalMessage = result.items.findLast(
    (item) => isMessageItem(item) && item.role === 'assistant' && messageText(item).length > 0,
  );
  assert.ok(finalMessage && isMessageItem(finalMessage));
  assert.equal(messageText(finalMessage), result.answer);
  assert.doesNotMatch(JSON.stringify(result.items), /tool_calls|tool_call_id/);
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
    maxHistoryTurns: 1,
  });

  const first = await agent.run('first', history);
  assert.equal(requests[0]?.items[1]?.id, 'recent-user');
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
