import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { acquireFileLock, FileLockError, withFileLock } from '../../../../src/runtime/file-lock.js';

test('文件锁在多个调用者之间串行执行临界区', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'echolens-file-lock-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'state.lock');
  let releaseFirst!: () => void;
  const gate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  let entered = 0;
  let maxEntered = 0;
  let firstStarted!: () => void;
  const started = new Promise<void>((resolve) => { firstStarted = resolve; });

  const first = withFileLock(path, async () => {
    entered += 1;
    maxEntered = Math.max(maxEntered, entered);
    firstStarted();
    await gate;
    entered -= 1;
  });
  await started;
  const second = withFileLock(path, async () => {
    entered += 1;
    maxEntered = Math.max(maxEntered, entered);
    entered -= 1;
  });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(maxEntered, 1);
  releaseFirst();
  await Promise.all([first, second]);
  assert.equal(maxEntered, 1);
});

test('文件锁拒绝活跃所有者并在释放后允许重新获取', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'echolens-file-lock-live-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'state.lock');
  const first = await acquireFileLock(path);
  await assert.rejects(acquireFileLock(path, { timeoutMs: 10, retryDelayMs: 2 }), FileLockError);
  await first.release();
  const reopened = await acquireFileLock(path, { timeoutMs: 10 });
  await reopened.release();
});

test('文件锁清理已退出进程留下的所有者记录', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'echolens-file-lock-stale-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'state.lock');
  await writeFile(path, JSON.stringify({
    version: 1,
    token: 'stale-owner',
    pid: 999_999_999,
    hostname: hostname(),
    createdAt: '2026-08-31T00:00:00.000Z',
  }));

  const lock = await acquireFileLock(path, { timeoutMs: 10, processAlive: () => false });
  assert.doesNotMatch(await readFile(path, 'utf8'), /stale-owner/u);
  await lock.release();
});

test('文件锁释放失败后可以重试', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'echolens-file-lock-release-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'state.lock');
  const lock = await acquireFileLock(path);
  const owner = await readFile(path, 'utf8');

  await rm(path);
  await mkdir(path);
  await assert.rejects(lock.release());

  await rm(path, { recursive: true });
  await writeFile(path, owner);
  await lock.release();
  await assert.rejects(stat(path), { code: 'ENOENT' });
});
