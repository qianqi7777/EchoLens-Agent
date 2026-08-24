import assert from 'node:assert/strict';
import test from 'node:test';
import {
  textMessage,
  type ToolCallItem,
  type ToolResultItem,
} from '../core/messages.js';
import type {
  ModelProvider,
  ProviderCapabilities,
  ProviderRequest,
  ProviderResult,
} from '../providers/types.js';
import { ReactAgent } from './react-loop.js';
import { ToolExecutor } from './tool-executor.js';
import { ToolRegistry } from './tool-registry.js';
import type { ToolContext, ToolSpec } from './types.js';

const emptySchema = {
  type: 'object' as const,
  properties: {},
  required: [],
  additionalProperties: false as const,
};

test('unknown tools and unexpected exceptions return stable errors without raw exception text', async () => {
  const registry = new ToolRegistry();
  registry.register(tool('sync_failure', () => {
    throw new Error('secret-sync-stack-message');
  }));
  registry.register(tool('async_failure', async () => {
    throw new Error('secret-async-stack-message');
  }));
  const executor = new ToolExecutor(registry);

  const unknown = await executor.invoke('missing_tool', {}, context());
  assert.equal(unknown.status, 'invalid');
  assert.equal(unknown.error?.code, 'unknown_tool');

  for (const name of ['sync_failure', 'async_failure']) {
    const result = await executor.invoke(name, {}, context());
    assert.equal(result.status, 'failed');
    assert.equal(result.error?.code, 'tool_failed');
    assert.equal(result.content.includes('secret-'), false);
    assert.equal(result.summary.includes('secret-'), false);
  }
});

test('timeouts, cancellation, permission denial, and budget exhaustion stay distinct', async () => {
  const registry = new ToolRegistry();
  registry.register(tool('wait', async () => new Promise(() => {})));
  registry.register(tool('ok', async () => ({
    status: 'ok',
    content: 'ok',
    summary: 'ok',
    evidenceIds: [],
  })));

  const timeoutExecutor = new ToolExecutor(registry, { timeoutMs: 5 });
  const timeout = await timeoutExecutor.invoke('wait', {}, context());
  assert.equal(timeout.status, 'timeout');
  assert.equal(timeout.error?.code, 'timeout');
  assert.equal(timeout.error?.retryable, true);

  let started!: () => void;
  const executionStarted = new Promise<void>((resolve) => { started = resolve; });
  const cancellationRegistry = new ToolRegistry();
  cancellationRegistry.register(tool('cancel_me', async (_args, toolContext) => {
    started();
    return new Promise((_resolve, reject) => {
      toolContext.signal.addEventListener(
        'abort',
        () => reject(new Error('secret-cancel-message')),
        { once: true },
      );
    });
  }));
  const controller = new AbortController();
  const cancellation = new ToolExecutor(cancellationRegistry, { timeoutMs: 1000 })
    .invoke('cancel_me', {}, context(controller.signal));
  await executionStarted;
  controller.abort();
  const cancelled = await cancellation;
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.error?.code, 'cancelled');
  assert.equal(cancelled.content.includes('secret-cancel-message'), false);

  const budgetExecutor = new ToolExecutor(registry, { maxCalls: 1 });
  const denied = await budgetExecutor.invoke('ok', {}, context(undefined, new Set()));
  assert.equal(denied.status, 'denied');
  assert.equal(denied.error?.code, 'permission_denied');
  assert.equal((await budgetExecutor.invoke('ok', {}, context())).status, 'ok');
  const exhausted = await budgetExecutor.invoke('ok', {}, context());
  assert.equal(exhausted.status, 'failed');
  assert.equal(exhausted.error?.code, 'budget_exhausted');
});

test('ReactAgent replays structured tool errors so the model can correct the next step', async () => {
  let turn = 0;
  const provider: ModelProvider = {
    model: 'error-aware-model',
    capabilities,
    async complete(request: ProviderRequest): Promise<ProviderResult> {
      turn += 1;
      if (turn === 1) {
        const call: ToolCallItem = {
          type: 'tool_call',
          id: 'item-call-1',
          callId: 'call-1',
          name: 'missing_tool',
          arguments: {},
          callIndex: 0,
        };
        return { output: [call], stopReason: 'tool_calls' };
      }
      const result = request.items.find((item): item is ToolResultItem => item.type === 'tool_result');
      assert.equal(result?.status, 'invalid');
      assert.equal(result?.error?.code, 'unknown_tool');
      assert.equal(result?.output.content.includes('unknown_tool'), true);
      return {
        output: [textMessage('assistant-final', 'assistant', '已根据错误修正。')],
        stopReason: 'completed',
      };
    },
  };

  const registry = new ToolRegistry();
  const result = await new ReactAgent(provider, registry, new ToolExecutor(registry), {
    workspaceRoot: process.cwd(),
  }).run('调用工具');
  assert.equal(result.answer, '已根据错误修正。');
  assert.equal(turn, 2);
});

function tool(
  name: string,
  execute: ToolSpec['execute'],
): ToolSpec {
  return {
    name,
    description: name,
    permission: 'workspace.read',
    inputSchema: emptySchema,
    execute,
  };
}

function context(
  signal = new AbortController().signal,
  permissions: ReadonlySet<'workspace.read'> = new Set(['workspace.read']),
): ToolContext {
  return {
    workspaceRoot: process.cwd(),
    allowedPermissions: permissions,
    signal,
  };
}

const capabilities: ProviderCapabilities = {
  maxContextTokens: 16_000,
  supportsStreaming: false,
  supportsToolCalls: true,
  supportsParallelToolCalls: false,
  supportsStructuredOutput: false,
  supportsPromptCaching: false,
  supportsUsageReporting: false,
};
