import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { BackgroundTaskWorker } from '../../../../src/orchestration/background-worker.js';
import { PersistentTaskQueue } from '../../../../src/orchestration/task-queue.js';

test('Worker pool runs four I/O-bound tasks concurrently with measured latency', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'echolens-worker-pool-perf-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const queue = new PersistentTaskQueue(join(root, 'tasks.json'));
  for (let index = 0; index < 4; index += 1) {
    await queue.enqueue({ isolation: 'sandbox', payload: { profile: 'explore', objective: `task-${index}` } });
  }
  const workMs = 300;
  const startedAt = Date.now();
  let running = 0;
  let maxRunning = 0;
  const worker = new BackgroundTaskWorker(queue, {
    execute: async () => {
      running += 1;
      maxRunning = Math.max(maxRunning, running);
      await new Promise((resolve) => setTimeout(resolve, workMs));
      running -= 1;
      return { state: 'completed', result: { summary: 'measured', evidenceIds: [] } };
    },
  }, { workerId: 'pool-perf', concurrency: 4, pollMs: 5 });
  t.after(() => worker.stop());
  await worker.start();
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline && (await queue.list()).some((task) => task.state !== 'completed')) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const elapsedMs = Date.now() - startedAt;
  await worker.stop();
  const tasks = await queue.list();
  assert.ok(tasks.every((task) => task.state === 'completed'));
  assert.equal(maxRunning, 4);
  assert.ok(elapsedMs < workMs * 3, `并行耗时 ${elapsedMs}ms 应显著低于串行基准 ${workMs * 4}ms`);
  console.log(`WORKER_POOL_BENCHMARK tasks=4 concurrency=4 maxRunning=${maxRunning} elapsedMs=${elapsedMs} serialBaselineMs=${workMs * 4}`);
});
