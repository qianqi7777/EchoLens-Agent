import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, stat, unlink } from 'node:fs/promises';
import { hostname } from 'node:os';
import { dirname } from 'node:path';

export interface FileLockOptions {
  timeoutMs?: number;
  retryDelayMs?: number;
  staleMs?: number;
  now?: () => number;
  processAlive?: (pid: number) => boolean;
}

export interface FileLock {
  readonly path: string;
  release(): Promise<void>;
}

interface LockOwner {
  version: 1;
  token: string;
  pid: number;
  hostname: string;
  createdAt: string;
}

export class FileLockError extends Error {
  readonly code = 'file_locked';

  constructor(readonly path: string) {
    super(`文件正被另一个进程使用：${path}`);
    this.name = 'FileLockError';
  }
}

/** 使用原子排他创建在本机进程间串行访问一个持久化文件。 */
export async function acquireFileLock(
  path: string,
  options: FileLockOptions = {},
): Promise<FileLock> {
  const timeoutMs = nonNegativeInteger(options.timeoutMs ?? 5_000, 'timeoutMs');
  const retryDelayMs = positiveInteger(options.retryDelayMs ?? 20, 'retryDelayMs');
  const staleMs = positiveInteger(options.staleMs ?? 5_000, 'staleMs');
  const now = options.now ?? Date.now;
  const processAlive = options.processAlive ?? defaultProcessAlive;
  const deadline = now() + timeoutMs;
  const owner: LockOwner = {
    version: 1,
    token: randomUUID(),
    pid: process.pid,
    hostname: hostname(),
    createdAt: new Date(now()).toISOString(),
  };

  await mkdir(dirname(path), { recursive: true });
  while (true) {
    try {
      const handle = await open(path, 'wx', 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(owner)}\n`, 'utf8');
      } finally {
        await handle.close();
      }
      let released = false;
      return {
        path,
        async release() {
          if (released) return;
          await releaseOwnedLock(path, owner.token);
          released = true;
        },
      };
    } catch (error) {
      // Windows 在并发 `open(..., 'wx')` 时可能把共享冲突报告为 EPERM/EACCES，
      // 而不是 POSIX 常见的 EEXIST。锁刚被另一个调用者删除时，文件句柄的共享
      // 冲突还可能短暂存在，此时锁路径已经返回 ENOENT；只要父目录仍可见，就把
      // 这个短暂窗口归为竞争，避免并发持久化在 Windows 上偶发失败。
      if (!(isNodeError(error, 'EEXIST')
        || ((isNodeError(error, 'EPERM') || isNodeError(error, 'EACCES')) && await lockPathContention(path)))) throw error;
      if (await removeStaleLock(path, staleMs, now, processAlive)) continue;
      const remaining = deadline - now();
      if (remaining <= 0) throw new FileLockError(path);
      await delay(Math.min(retryDelayMs, remaining));
    }
  }
}

async function lockPathContention(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) {
      // `open(wx)` 与前一个调用者的 unlink 之间可能存在一个 Windows
      // 共享冲突窗口。父目录可访问时，ENOENT 只表示锁刚释放，不是权限错误。
      try {
        const parent = await stat(dirname(path));
        return parent.isDirectory();
      } catch (parentError) {
        if (isNodeError(parentError, 'ENOENT')) return false;
        throw parentError;
      }
    }
    throw error;
  }
}

export async function withFileLock<T>(
  path: string,
  operation: () => Promise<T>,
  options?: FileLockOptions,
): Promise<T> {
  const lock = await acquireFileLock(path, options);
  try {
    return await operation();
  } finally {
    await lock.release();
  }
}

async function removeStaleLock(
  path: string,
  staleMs: number,
  now: () => number,
  processAlive: (pid: number) => boolean,
): Promise<boolean> {
  const owner = await readOwner(path);
  if (owner) {
    if (owner.hostname !== hostname() || processAlive(owner.pid)) return false;
  } else {
    try {
      const info = await stat(path);
      if (now() - info.mtimeMs < staleMs) return false;
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) return true;
      throw error;
    }
  }
  try {
    await unlink(path);
    return true;
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return true;
    throw error;
  }
}

async function releaseOwnedLock(path: string, token: string): Promise<void> {
  const owner = await readOwner(path);
  if (!owner || owner.token !== token) return;
  try {
    await unlink(path);
  } catch (error) {
    if (!isNodeError(error, 'ENOENT')) throw error;
  }
}

async function readOwner(path: string): Promise<LockOwner | undefined> {
  try {
    const value = JSON.parse(await readFile(path, 'utf8')) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const owner = value as Partial<LockOwner>;
    return owner.version === 1
      && typeof owner.token === 'string'
      && Number.isInteger(owner.pid) && (owner.pid ?? 0) > 0
      && typeof owner.hostname === 'string'
      && typeof owner.createdAt === 'string'
      ? owner as LockOwner
      : undefined;
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return undefined;
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
}

function defaultProcessAlive(pid: number): boolean {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !isNodeError(error, 'ESRCH');
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} 必须是正整数`);
  return value;
}

function nonNegativeInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 0) throw new Error(`${name} 必须是非负整数`);
  return value;
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === code;
}
