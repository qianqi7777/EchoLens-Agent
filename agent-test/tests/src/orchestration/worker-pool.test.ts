import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { BackgroundTaskWorker } from '../../../../src/orchestration/background-worker.js';
import { PersistentTaskQueue } from '../../../../src/orchestration/task-queue.js';

test('Worker 池达到配置并发且同 workspaceKey 只运行一个任务', { timeout: 5_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'echolens-worker-pool-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const queue = new PersistentTaskQueue(join(root, 'tasks.json'));
  const sameOne = await queue.enqueue({ isolation: 'worktree', payload: {
    profile: 'test', objective: 'same one', metadata: { workspaceKey: 'workspace:a' },
  } });
  const sameTwo = await queue.enqueue({ isolation: 'worktree', payload: {
    profile: 'review', objective: 'same two', metadata: { workspaceKey: 'workspace:a' },
  } });
  const other = await queue.enqueue({ isolation: 'sandbox', payload: {
    profile: 'explore', objective: 'different workspace', metadata: { workspaceKey: 'workspace:b' },
  } });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const started: string[] = [];
  let holdExecutions = true;
  const worker = new BackgroundTaskWorker(queue, {
    execute: async (task) => {
      started.push(task.id);
      if (holdExecutions) await gate;
      return { state: 'completed', result: { summary: 'done', evidenceIds: [] } };
    },
  }, { workerId: 'pool-test', concurrency: 2, pollMs: 5 });
  t.after(async () => { release(); await worker.stop(); });

  await worker.start();
  await waitFor(async () => started.includes(sameOne.id) && started.includes(other.id));
  assert.equal(started.includes(sameTwo.id), false, '相同 workspace 在首任务占用时必须排队');
  assert.equal((await queue.get(sameTwo.id))?.state, 'pending');
  assert.deepEqual(worker.workerStatus, { concurrency: 2, running: 2 });
  holdExecutions = false;
  release();
  await waitFor(async () => (await queue.list()).every((task) => task.state === 'completed'));
  assert.equal(started.filter((id) => id === sameTwo.id).length, 1);
  await worker.stop();
});

test('并发 Worker 启动时恢复过期租约且继续遵守 workspace 互斥', { timeout: 5_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'echolens-worker-lease-recovery-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let now = new Date('2026-09-23T00:00:00.000Z');
  const queue = new PersistentTaskQueue(join(root, 'tasks.json'), () => now);
  const expired = await queue.enqueue({ isolation: 'worktree', payload: {
    profile: 'test', objective: 'expired lease', metadata: { workspaceKey: 'workspace:a' },
  } });
  await queue.claim('dead-worker', 1_000);
  const sameWorkspace = await queue.enqueue({ isolation: 'worktree', payload: {
    profile: 'review', objective: 'same workspace waiter', metadata: { workspaceKey: 'workspace:a' },
  } });
  const otherWorkspace = await queue.enqueue({ isolation: 'sandbox', payload: {
    profile: 'explore', objective: 'other workspace', metadata: { workspaceKey: 'workspace:b' },
  } });
  now = new Date('2026-09-23T00:00:02.000Z');
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const started: string[] = [];
  let holdExecutions = true;
  const worker = new BackgroundTaskWorker(queue, {
    execute: async (task) => {
      started.push(task.id);
      if (holdExecutions) await gate;
      return { state: 'completed', result: { summary: 'recovered', evidenceIds: [] } };
    },
  }, { workerId: 'recovery-pool', concurrency: 2, pollMs: 5, leaseMs: 1_000 });
  t.after(async () => { release(); await worker.stop(); });

  await worker.start();
  await waitFor(async () => started.includes(expired.id) && started.includes(otherWorkspace.id));
  assert.equal((await queue.get(expired.id))?.attempts, 2);
  assert.equal((await queue.get(sameWorkspace.id))?.state, 'pending');
  assert.equal(started.includes(sameWorkspace.id), false);
  holdExecutions = false;
  release();
  await waitFor(async () => (await queue.list()).every((task) => task.state === 'completed'));
  await worker.stop();
});

test('Worker 并发配置拒绝越界值', async () => {
  const worker = new BackgroundTaskWorker({
    claimNext: async () => undefined,
  } as unknown as PersistentTaskQueue, { execute: async () => ({ state: 'failed', code: 'unused', retryable: false }) }, { concurrency: 1 });
  assert.throws(() => worker.setConcurrency(0), /1 到 32/u);
  assert.throws(() => new BackgroundTaskWorker(
    {} as PersistentTaskQueue,
    { execute: async () => ({ state: 'failed', code: 'unused', retryable: false }) },
    { concurrency: 33 },
  ), /1 到 32/u);
});

test('并发 runOnce 调用不会越过池上限或丢失暂时释放的任务', { timeout: 5_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'echolens-worker-run-once-race-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const queue = new PersistentTaskQueue(join(root, 'tasks.json'));
  for (let index = 0; index < 3; index += 1) {
    await queue.enqueue({ isolation: 'sandbox', payload: { profile: 'explore', objective: `race-${index}` } });
  }
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let running = 0;
  let maxRunning = 0;
  let executions = 0;
  const worker = new BackgroundTaskWorker(queue, {
    execute: async () => {
      executions += 1;
      running += 1;
      maxRunning = Math.max(maxRunning, running);
      await gate;
      running -= 1;
      return { state: 'completed', result: { summary: 'done', evidenceIds: [] } };
    },
  }, { workerId: 'run-once-race', concurrency: 1 });
  t.after(async () => { release(); await worker.stop(); });

  const runs = Promise.all([worker.runOnce(), worker.runOnce()]);
  await waitFor(async () => executions > 0);
  assert.equal(executions, 1);
  assert.equal(worker.workerStatus.running, 1);
  release();
  const outcomes = await runs;
  assert.equal(outcomes.filter(Boolean).length, 1);
  assert.equal(maxRunning, 1);
  const tasks = await queue.list();
  assert.equal(tasks.filter((task) => task.state === 'pending').length, 2);
  assert.equal(tasks.reduce((total, task) => total + task.attempts, 0), 1);
});

async function waitFor(predicate: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail('等待 Worker 池状态超时');
}
