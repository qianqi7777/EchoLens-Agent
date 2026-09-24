import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { executeBackgroundTaskCommand, formatUsageSummary } from '../../../../src/orchestration/task-command.js';
import { PersistentTaskQueue } from '../../../../src/orchestration/task-queue.js';

test('后台任务持久化 usage，并按任务和会话汇总已知成本', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'echolens-task-usage-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const queue = new PersistentTaskQueue(join(root, 'tasks.json'));
  const task = await queue.enqueue({ isolation: 'sandbox', payload: {
    profile: 'test', objective: 'measure', metadata: { sessionId: 'session-a' },
  } });
  await queue.claim('worker-a');
  const completed = await queue.complete(task.id, 'worker-a', {
    summary: 'done', evidenceIds: ['ev-usage'],
    usage: { inputTokens: 100, outputTokens: 25, cachedTokens: 10, modelSteps: 2, toolCalls: 3 },
    estimatedCost: { amount: 0.00125, currency: 'USD' },
  });
  assert.deepEqual(completed.usage, { inputTokens: 100, outputTokens: 25, cachedTokens: 10, modelSteps: 2, toolCalls: 3 });
  assert.deepEqual(completed.estimatedCost, { amount: 0.00125, currency: 'USD' });
  const lines = formatUsageSummary(await queue.list());
  assert.match(lines.join('\n'), /test \| input=100 output=25 cached=10 steps=2 tools=3 cost=USD 0\.001250/u);
  assert.match(lines.join('\n'), /session-a \| tasks=1 \| input=100 output=25 cached=10 steps=2 tools=3 cost=USD 0\.001250/u);
  const service = { list: () => queue.list(), enqueue: async () => { throw new Error('unused'); }, cancel: async () => { throw new Error('unused'); }, resume: async () => { throw new Error('unused'); } };
  const tasksCommand = await executeBackgroundTaskCommand('/tasks', service);
  assert.match(tasksCommand.lines.join('\n'), /input=100 output=25 cached=10 steps=2 tools=3 cost=USD 0\.001250/u);
  const sessionCommand = await executeBackgroundTaskCommand('/usage session-a', service);
  assert.match(sessionCommand.lines.join('\n'), /会话用量：session-a/u);
});

test('缺单价明确显示 unknown，不伪装成零成本', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'echolens-task-usage-unknown-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const queue = new PersistentTaskQueue(join(root, 'tasks.json'));
  const task = await queue.enqueue({ isolation: 'sandbox', payload: { profile: 'explore', objective: 'measure' } });
  await queue.claim('worker-a');
  await queue.complete(task.id, 'worker-a', {
    summary: 'done', evidenceIds: [],
    usage: { inputTokens: 1, outputTokens: 2, modelSteps: 1, toolCalls: 0 },
    estimatedCost: { unknown: true },
  });
  const service = { list: () => queue.list(), enqueue: async () => { throw new Error('unused'); }, cancel: async () => { throw new Error('unused'); }, resume: async () => { throw new Error('unused'); } };
  const result = await executeBackgroundTaskCommand('/usage', service);
  assert.match(result.lines.join('\n'), /cost=unknown/u);
  assert.doesNotMatch(result.lines.join('\n'), /cost=USD 0/u);
});
