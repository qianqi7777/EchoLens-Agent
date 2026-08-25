import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { textMessage, type ToolCallItem } from '../core/messages.js';
import type {
  ModelProvider,
  ProviderCapabilities,
  ProviderRequest,
  ProviderResult,
} from '../providers/types.js';
import { JsonlEventStore } from '../session/jsonl-event-store.js';
import { ReactAgent } from './react-loop.js';
import { ToolExecutor } from './tool-executor.js';
import { ToolRegistry } from './tool-registry.js';
import { toolSuccess } from './tool-result.js';
import { ToolScheduler } from './tool-scheduler.js';

const capabilities: ProviderCapabilities = {
  maxContextTokens: 16_384,
  supportsStreaming: false,
  supportsToolCalls: true,
  supportsParallelToolCalls: true,
  supportsStructuredOutput: false,
  supportsPromptCaching: false,
  supportsUsageReporting: true,
};

test('十个只读工具有界并发且结果按 callIndex 回填', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'echolens-scheduler-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const registry = new ToolRegistry();
  let active = 0;
  let maxActive = 0;
  const completionOrder: number[] = [];
  registry.register({
    name: 'delayed_read',
    description: '延迟只读工具',
    permission: 'workspace.read',
    effect: 'read',
    inputSchema: {
      type: 'object',
      properties: { index: { type: 'integer' }, delay: { type: 'integer' } },
      required: ['index', 'delay'],
      additionalProperties: false,
    },
    async execute(args) {
      const index = args.index as number;
      active += 1;
      maxActive = Math.max(maxActive, active);
      await delay(args.delay as number);
      active -= 1;
      completionOrder.push(index);
      return toolSuccess(String(index), `read ${index}`);
    },
  });
  const requests: ProviderRequest[] = [];
  const store = new JsonlEventStore(join(root, 'sessions'), 'parallel-session', {
    flushEachEvent: false,
  });
  const agent = new ReactAgent(
    parallelProvider(requests),
    registry,
    new ToolExecutor(registry),
    {
      workspaceRoot: root,
      toolScheduler: new ToolScheduler({ maxReadConcurrency: 3, maxTotalConcurrency: 3 }),
    },
  );
  const result = await agent.run('并行读取', [], undefined, {
    sessionId: 'parallel-session',
    eventSink: store,
  });
  const events = await store.read();
  await store.close();

  assert.equal(result.state, 'completed');
  assert.equal(maxActive, 3);
  assert.notDeepEqual(completionOrder, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  const replayed = requests[1]?.items.filter((item) => item.type === 'tool_result') ?? [];
  assert.deepEqual(replayed.map((item) => Number(item.summary.split(' ')[1])), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.deepEqual(events.map((event) => event.seq), events.map((_, index) => index + 1));
  assert.equal(events.filter((event) => event.payload.type === 'tool.completed').length, 10);
});

test('副作用工具不会与前后只读波次交叉', async () => {
  const registry = new ToolRegistry();
  registry.register({
    name: 'read',
    description: 'read',
    permission: 'workspace.read',
    effect: 'read',
    inputSchema: { type: 'object', additionalProperties: false },
    async execute() { return toolSuccess('ok', 'ok'); },
  });
  registry.register({
    name: 'write',
    description: 'write',
    permission: 'workspace.write',
    effect: 'write',
    inputSchema: { type: 'object', additionalProperties: false },
    async execute() { return toolSuccess('ok', 'ok'); },
  });
  const timeline: string[] = [];
  const scheduler = new ToolScheduler({ maxReadConcurrency: 2, maxTotalConcurrency: 2 });
  const calls = [call('read', 'read-0', 0), call('read', 'read-1', 1), call('write', 'write-2', 2), call('read', 'read-3', 3)];

  await scheduler.execute(calls, registry, async (item) => {
    timeline.push(`start:${item.callId}`);
    await delay(item.name === 'write' ? 5 : 20);
    timeline.push(`end:${item.callId}`);
    return item.callId;
  });

  assert.ok(timeline.indexOf('start:write-2') > timeline.indexOf('end:read-0'));
  assert.ok(timeline.indexOf('start:write-2') > timeline.indexOf('end:read-1'));
  assert.ok(timeline.indexOf('start:read-3') > timeline.indexOf('end:write-2'));
});

test('并行工具不能穿透 ToolExecutor 调用预算', async () => {
  const registry = new ToolRegistry();
  let executions = 0;
  registry.register({
    name: 'budgeted_read',
    description: '受预算限制的只读工具',
    permission: 'workspace.read',
    effect: 'read',
    inputSchema: { type: 'object', additionalProperties: false },
    async execute() {
      executions += 1;
      return toolSuccess('ok', 'ok');
    },
  });
  const executor = new ToolExecutor(registry, { maxCalls: 2 });
  const context = {
    workspaceRoot: process.cwd(),
    allowedPermissions: new Set(['workspace.read' as const]),
    signal: new AbortController().signal,
  };

  const outcomes = await Promise.all(Array.from({ length: 10 }, () => executor.invokeWithDecision(
    'budgeted_read',
    {},
    context,
    async () => delay(5),
  )));

  assert.equal(executions, 2);
  assert.equal(outcomes.filter((outcome) => outcome.result.status === 'ok').length, 2);
  assert.equal(outcomes.filter((outcome) => outcome.result.error?.code === 'budget_exhausted').length, 8);
  assert.equal(executor.callsUsed(), 2);
});

function parallelProvider(requests: ProviderRequest[]): ModelProvider {
  let turn = 0;
  return {
    model: 'parallel-provider',
    capabilities,
    async complete(request): Promise<ProviderResult> {
      requests.push(request);
      turn += 1;
      if (turn === 1) {
        return {
          output: [
            textMessage('assistant-tools', 'assistant', ''),
            ...Array.from({ length: 10 }, (_, index) => ({
              type: 'tool_call' as const,
              id: `item-${index}`,
              callId: `call-${index}`,
              name: 'delayed_read',
              arguments: { index, delay: (10 - index) * 3 },
              callIndex: index,
            })),
          ],
          stopReason: 'tool_calls',
        };
      }
      return {
        output: [textMessage('assistant-final', 'assistant', '并行完成。')],
        stopReason: 'completed',
      };
    },
  };
}

function call(name: string, callId: string, callIndex: number): ToolCallItem {
  return { type: 'tool_call', id: `item-${callId}`, callId, name, arguments: {}, callIndex };
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
