import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { BackgroundTaskWorker } from '../../../../src/orchestration/background-worker.js';
import { PersistentTaskQueue } from '../../../../src/orchestration/task-queue.js';
import { DefaultTaskWorkspaceAllocator } from '../../../../src/orchestration/workspace-allocator.js';

const execute = promisify(execFile);

test('持久任务队列恢复过期租约，并支持等待审批、恢复和完成', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'echolens-task-queue-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  // 可注入时钟驱动租约过期：认领后推进 2s 越过 1s 租约，避免真实 sleep 才能覆盖 recoverExpired。
  let now = new Date('2026-08-29T00:00:00.000Z');
  const queue = new PersistentTaskQueue(join(root, 'tasks.json'), () => now);
  const task = await queue.enqueue({ isolation: 'sandbox', payload: { profile: 'explore', objective: 'inspect' } });
  await queue.claim('dead-worker', 1_000);
  now = new Date('2026-08-29T00:00:02.000Z');
  assert.equal(await queue.recoverExpired(), 1);
  assert.equal((await queue.get(task.id))?.state, 'pending');

  let execution = 0;
  const worker = new BackgroundTaskWorker(queue, {
    execute: async () => {
      execution += 1;
      return execution === 1
        ? { state: 'waiting_approval', reason: 'approval needed' }
        : { state: 'completed', result: { summary: 'done', evidenceIds: ['ev-1'] } };
    },
  }, { workerId: 'worker-a' });
  assert.equal(await worker.runOnce(), true);
  assert.equal((await queue.get(task.id))?.state, 'waiting_approval');
  await queue.resume(task.id);
  assert.equal(await worker.runOnce(), true);
  const completed = await queue.get(task.id);
  assert.equal(completed?.state, 'completed');
  assert.deepEqual(completed?.result?.evidenceIds, ['ev-1']);
});

test('运行中任务取消立即进入终态', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'echolens-task-cancel-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const queue = new PersistentTaskQueue(join(root, 'tasks.json'));
  const task = await queue.enqueue({ isolation: 'sandbox', payload: { profile: 'review', objective: 'review' } });
  await queue.claim('worker-a');
  const cancelled = await queue.cancel(task.id);
  assert.equal(cancelled.state, 'cancelled');
  assert.equal(cancelled.workerId, undefined);
});

test('Worker 取消竞态保持 cancelled，通知异常不会中断任务收尾', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'echolens-task-cancel-race-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const queue = new PersistentTaskQueue(join(root, 'tasks.json'));
  const task = await queue.enqueue({ isolation: 'sandbox', payload: { profile: 'test', objective: 'run' } });
  let release!: () => void;
  const executing = new Promise<void>((resolve) => { release = resolve; });
  const worker = new BackgroundTaskWorker(queue, {
    execute: async () => {
      await executing;
      return { state: 'completed', result: { summary: 'late result', evidenceIds: [] } };
    },
  }, {
    workerId: 'worker-race',
    onStateChange: async () => { throw new Error('notification unavailable'); },
  });
  // 竞态窗口：execute 阻塞在 executing 上，等任务进入 running 后 cancel，
  // 再放行 execute 返回 completed，验证“迟到的完成结果”不会覆盖已取消状态、也不写入 result。
  const running = worker.runOnce();
  while ((await queue.get(task.id))?.state !== 'running') await new Promise((resolve) => setTimeout(resolve, 5));
  await worker.cancel(task.id);
  release();
  await running;
  const cancelled = await queue.get(task.id);
  assert.equal(cancelled?.state, 'cancelled');
  assert.equal(cancelled?.result, undefined);
});

test('取消终态任务保持原结果且不写入取消标记', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'echolens-task-terminal-cancel-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const queue = new PersistentTaskQueue(join(root, 'tasks.json'));
  const task = await queue.enqueue({ isolation: 'sandbox', payload: { profile: 'review', objective: 'review' } });
  await queue.claim('worker-a');
  await queue.complete(task.id, 'worker-a', { summary: 'done', evidenceIds: ['ev-1'] });
  const completed = await queue.cancel(task.id);
  assert.equal(completed.state, 'completed');
  assert.equal(completed.cancellationRequested, undefined);
  assert.equal(completed.result?.summary, 'done');
});

test('Worker 正常停止会释放任务租约以便下次显式恢复', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'echolens-task-worker-stop-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const queue = new PersistentTaskQueue(join(root, 'tasks.json'));
  const task = await queue.enqueue({ isolation: 'sandbox', payload: { profile: 'explore', objective: 'inspect' } });
  const worker = new BackgroundTaskWorker(queue, {
    execute: async (_task, signal) => new Promise((resolve) => {
      signal.addEventListener('abort', () => resolve({
        state: 'failed', code: 'aborted', retryable: true,
      }), { once: true });
    }),
  }, { workerId: 'worker-stop', pollMs: 5 });
  await worker.start();
  while ((await queue.get(task.id))?.state !== 'running') await new Promise((resolve) => setTimeout(resolve, 5));
  await worker.stop();
  const pending = await queue.get(task.id);
  assert.equal(pending?.state, 'pending');
  assert.equal(pending?.workerId, undefined);
  assert.equal(pending?.attempts, 0);
});

test('损坏的后台队列失败关闭而不是静默重置', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'echolens-task-corrupt-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const filePath = join(root, 'tasks.json');
  // Fixture 故意写入非法 state，验证队列对损坏文件失败关闭而非静默重置。
  await writeFile(filePath, JSON.stringify({ version: 1, tasks: [{ schemaVersion: 1, id: 'bad', state: 'unknown' }] }));
  const queue = new PersistentTaskQueue(filePath);
  await assert.rejects(queue.list(), /队列结构无效/u);
});

test('队列写入端拒绝无效 metadata 并规范化 Evidence ID', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'echolens-task-validation-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const queue = new PersistentTaskQueue(join(root, 'tasks.json'));
  // NaN 属于 number 但非有限值，校验必须拒绝；evidenceIds 单条超长会被截断到 1000 字符上限。
  await assert.rejects(queue.enqueue({
    isolation: 'sandbox',
    payload: { profile: 'explore', objective: 'inspect', metadata: { invalid: Number.NaN } },
  }), /metadata 无效/u);
  const task = await queue.enqueue({ isolation: 'sandbox', payload: { profile: 'explore', objective: 'inspect' } });
  await queue.claim('worker-a');
  const completed = await queue.complete(task.id, 'worker-a', { summary: 'done', evidenceIds: ['x'.repeat(2_000)] });
  assert.equal(completed.result?.evidenceIds[0]?.length, 1_000);
  assert.equal((await queue.get(task.id))?.state, 'completed');
});

test('多个队列实例并发写入时不丢任务且不残留临时文件', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'echolens-task-multi-writer-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const filePath = join(root, 'tasks.json');
  const queues = [new PersistentTaskQueue(filePath), new PersistentTaskQueue(filePath)];

  await Promise.all(Array.from({ length: 40 }, (_, index) => queues[index % 2]!.enqueue({
    isolation: 'sandbox',
    payload: { profile: 'explore', objective: `task-${index}` },
  })));

  assert.equal((await queues[0]!.list()).length, 40);
  assert.deepEqual((await readdir(root)).filter((name) => name.endsWith('.tmp')), []);
});

test('Worktree 分配使用独立 checkout，修改不影响原工作区并可清理', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'echolens-worktree-source-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await execute('git', ['init', root]);
  await execute('git', ['-C', root, 'config', 'user.email', 'test@example.invalid']);
  await execute('git', ['-C', root, 'config', 'user.name', 'EchoLens Test']);
  await writeFile(join(root, 'file.txt'), 'source\n');
  await writeFile(join(root, 'deleted.txt'), 'delete me\n');
  await execute('git', ['-C', root, 'add', 'file.txt', 'deleted.txt']);
  await execute('git', ['-C', root, 'commit', '-m', 'initial']);
  await writeFile(join(root, 'file.txt'), 'working tree\n');
  await writeFile(join(root, 'draft.txt'), 'untracked\n');
  await rm(join(root, 'deleted.txt'));

  const lease = await new DefaultTaskWorkspaceAllocator().allocate(root, 'worktree');
  const worktreeRoot = lease.root;
  assert.equal(await readFile(join(worktreeRoot, 'file.txt'), 'utf8'), 'working tree\n');
  assert.equal(await readFile(join(worktreeRoot, 'draft.txt'), 'utf8'), 'untracked\n');
  await assert.rejects(readFile(join(worktreeRoot, 'deleted.txt')));
  assert.deepEqual(await lease.changedFiles(), []);

  await writeFile(join(worktreeRoot, 'file.txt'), 'agent change\n');
  await rename(join(worktreeRoot, 'draft.txt'), join(worktreeRoot, 'moved.txt'));
  assert.deepEqual(await lease.changedFiles(), ['draft.txt', 'file.txt', 'moved.txt']);
  assert.equal(await readFile(join(root, 'file.txt'), 'utf8'), 'working tree\n');
  assert.equal(await readFile(join(root, 'draft.txt'), 'utf8'), 'untracked\n');
  await lease.cleanup();
  await assert.rejects(readFile(join(worktreeRoot, 'file.txt')));
});
