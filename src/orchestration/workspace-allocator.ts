import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { chmod, lstat, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  FileSystemWorkspaceStager,
  type StagedFileSnapshot,
} from '../sandbox/workspace-stager.js';
import type { BackgroundTaskIsolation } from './task-queue.js';
import { validateRelativePath } from '../runtime/path-policy.js';

const execute = promisify(execFile);

/** 后台任务工作区租约：`cleanup` 必须由使用方在 finally 中调用，回收资源。 */
export interface TaskWorkspaceLease {
  id: string;
  mode: BackgroundTaskIsolation;
  root: string;
  workspaceKey: string;
  changedFiles(): Promise<string[]>;
  cleanup(): Promise<void>;
  /** Release the in-process lease while retaining the durable workspace. */
  suspend?(): Promise<void>;
  baseline?: readonly StagedFileSnapshot[];
}

export interface TaskWorkspaceAllocator {
  allocate(workspaceRoot: string, mode: BackgroundTaskIsolation, taskId?: string): Promise<TaskWorkspaceLease>;
}

/**
 * 按隔离模式分配后台任务工作区：sandbox 用一次性暂存副本，worktree 用 git worktree。
 * 工作区分配只做隔离，不做任何业务判断；任务能否写回由调用方依据 changedFiles 决策。
 */
export class DefaultTaskWorkspaceAllocator implements TaskWorkspaceAllocator {
  private readonly activeWorkspaceKeys = new Set<string>();

  constructor(private readonly stager = new FileSystemWorkspaceStager()) {}

  async allocate(workspaceRoot: string, mode: BackgroundTaskIsolation, taskId?: string): Promise<TaskWorkspaceLease> {
    if (taskId && !/^[a-f0-9-]{36}$/u.test(taskId)) throw new Error('持久工作区任务 ID 无效');
    const marker = taskId ? path.join(workspaceRoot, '.echolens', 'background-workspaces', `${taskId}.json`) : undefined;
    if (marker) await ensureManagedDirectory(workspaceRoot, path.dirname(marker));
    let lease = marker ? await this.reopen(workspaceRoot, mode, taskId!, marker) : undefined;
    if (!lease) {
      lease = await (mode === 'worktree' ? this.allocateWorktree(workspaceRoot, taskId) : this.allocateSandbox(workspaceRoot, taskId));
      if (marker) {
        try {
          await mkdir(path.dirname(marker), { recursive: true });
          const temporary = `${marker}.${randomUUID()}.tmp`;
          await writeFile(temporary, JSON.stringify({ version: 1, mode,
            baseline: (lease.baseline ?? []).map((file) => ({ path: file.path, mode: file.mode, content: file.bytes.toString('base64') })) }), { mode: 0o600 });
          await rename(temporary, marker);
        } catch (error) {
          await lease.cleanup();
          throw error;
        }
      }
    }
    // Use one canonical spelling for both the lease and its occupancy key.
    const workspaceKey = path.resolve(await realpath(lease.root));
    if (this.activeWorkspaceKeys.has(workspaceKey)) {
      if (!marker) await lease.cleanup();
      throw new Error('后台任务工作区已被占用');
    }
    this.activeWorkspaceKeys.add(workspaceKey);
    let released = false;
    return {
      ...lease,
      root: workspaceKey,
      workspaceKey,
      ...(marker ? { suspend: async () => {
        released = true;
        this.activeWorkspaceKeys.delete(workspaceKey);
      } } : {}),
      cleanup: async () => {
        if (released) return;
        await lease.cleanup();
        if (marker) await rm(marker, { force: true });
        released = true;
        this.activeWorkspaceKeys.delete(workspaceKey);
      },
    };
  }

  // sandbox 使用临时暂存副本：只读分析或运行受控测试，改动随 cleanup 丢弃，因此 changedFiles 恒为空。
  private async allocateSandbox(workspaceRoot: string, taskId?: string): Promise<TaskWorkspaceLease> {
    const id = `echolens-${taskId ?? randomUUID()}`;
    const staged = await this.stager.prepare(workspaceRoot, id);
    return {
      id,
      mode: 'sandbox',
      root: staged.root,
      workspaceKey: path.resolve(staged.root),
      changedFiles: async () => [],
      cleanup: staged.cleanup,
    };
  }

  private async allocateWorktree(workspaceRoot: string, taskId?: string): Promise<TaskWorkspaceLease> {
    const allocationId = taskId ?? randomUUID();
    const id = `echolens-worktree-${allocationId}`;
    const rootHash = createHash('sha256').update(path.resolve(workspaceRoot)).digest('hex').slice(0, 12);
    const base = path.join(os.tmpdir(), 'echolens-worktrees', rootHash);
    const target = path.join(base, id);
    // 先捕获过滤后的当前工作区，而不是只使用 HEAD；这样子 Agent 能看到用户尚未提交的代码，
    // 同时继续排除 .env、.git、.echolens、忽略文件和其它私有目录。
    const staged = await this.stager.prepare(workspaceRoot, `echolens-${allocationId}`);
    let worktreeAdded = false;
    await mkdir(base, { recursive: true });
    try {
      await execute('git', ['-C', workspaceRoot, 'worktree', 'add', '--detach', target, 'HEAD'], {
        windowsHide: true,
        maxBuffer: 4 * 1024 * 1024,
      });
      worktreeAdded = true;
      await applyBaseline(target, staged.baseline);
      await staged.cleanup();
    } catch (error) {
      const cleanupErrors = await cleanupOperations([
        () => staged.cleanup(),
        () => worktreeAdded
          ? cleanupWorktree(workspaceRoot, target)
          : rm(target, { recursive: true, force: true }),
      ]);
      const cleanupDetail = cleanupErrors.length
        ? `；清理失败：${cleanupErrors.map(safeMessage).join('；')}`
        : '';
      throw new Error(`无法创建后台 Worktree：${safeMessage(error)}${cleanupDetail}`);
    }
    let cleaned = false;
    return {
      id,
      mode: 'worktree',
      root: target,
      workspaceKey: path.resolve(target),
      baseline: staged.baseline,
      changedFiles: () => workspaceChanges(this.stager, target, staged.baseline),
      cleanup: async () => {
        // cleanup 只执行一次，确保外部多次调用时也只 remove 一次 worktree 并删除目录。
        if (cleaned) return;
        await cleanupWorktree(workspaceRoot, target);
        cleaned = true;
      },
    };
  }

  private async reopen(workspaceRoot: string, mode: BackgroundTaskIsolation, taskId: string, marker: string): Promise<TaskWorkspaceLease | undefined> {
    const info = await lstat(marker).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
    if (!info) return undefined;
    if (!info.isFile() || info.isSymbolicLink() || info.size > 96 * 1024 * 1024) throw new Error('持久工作区清单无效');
    const saved: unknown = JSON.parse(await readFile(marker, 'utf8'));
    const record = saved as { version?: unknown; mode?: unknown; baseline?: unknown } | null;
    if (!record || record.version !== 1 || record.mode !== mode || !Array.isArray(record.baseline)
      || record.baseline.length > 20_000) throw new Error('持久工作区清单不匹配');
    let total = 0;
    const baseline: StagedFileSnapshot[] = record.baseline.map((value: unknown) => {
      const file = value as { path?: unknown; mode?: unknown; content?: unknown } | null;
      if (!file || typeof file.path !== 'string' || typeof file.mode !== 'number' || typeof file.content !== 'string') throw new Error('持久基线无效');
      validateRelativePath(file.path);
      const bytes = Buffer.from(file.content, 'base64');
      total += bytes.length;
      if (bytes.length > 2 * 1024 * 1024 || total > 64 * 1024 * 1024) throw new Error('持久基线超过大小限制');
      return { path: file.path, mode: file.mode, bytes };
    });
    const rootHash = createHash('sha256').update(path.resolve(workspaceRoot)).digest('hex').slice(0, 12);
    const target = mode === 'sandbox'
      ? path.join(workspaceRoot, '.echolens', 'sandboxes', `echolens-${taskId}`, 'workspace')
      : path.join(os.tmpdir(), 'echolens-worktrees', rootHash, `echolens-worktree-${taskId}`);
    // Windows 8.3 aliases can differ from realpath without redirecting the directory.
    // Inspect every component instead: checking only the leaf misses parent Junctions.
    for (let directory = path.resolve(target); ; directory = path.dirname(directory)) {
      const component = await lstat(directory);
      if (!component.isDirectory() || component.isSymbolicLink()) throw new Error('持久工作区路径发生变化');
      if (path.dirname(directory) === directory) break;
    }
    return { id: `${mode}-${taskId}`, mode, root: target, workspaceKey: path.resolve(target), baseline,
      changedFiles: mode === 'worktree' ? () => workspaceChanges(this.stager, target, baseline) : async () => [],
      cleanup: () => mode === 'worktree' ? cleanupWorktree(workspaceRoot, target) : rm(path.dirname(target), { recursive: true, force: true }) };
  }
}

async function ensureManagedDirectory(workspaceRoot: string, directory: string): Promise<void> {
  const relative = path.relative(workspaceRoot, directory);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('持久目录越界');
  let current = workspaceRoot;
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    await mkdir(current).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'EEXIST') throw error; });
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('持久目录不能包含链接');
  }
}

async function cleanupWorktree(workspaceRoot: string, target: string): Promise<void> {
  let removeFailure: unknown;
  try {
    await execute('git', ['-C', workspaceRoot, 'worktree', 'remove', '--force', target], {
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
    });
  } catch (error) {
    removeFailure = error;
  }
  let directoryFailure: unknown;
  try {
    await rm(target, { recursive: true, force: true });
  } catch (error) {
    directoryFailure = error;
  }
  if (removeFailure && !directoryFailure) {
    try {
      // remove 失败但目录已删除时，prune 收敛 Git 管理元数据；成功即完成清理。
      await execute('git', ['-C', workspaceRoot, 'worktree', 'prune', '--expire', 'now'], {
        windowsHide: true,
        maxBuffer: 4 * 1024 * 1024,
      });
      removeFailure = undefined;
    } catch {
      // 保留原始 remove 错误，它通常比 prune 错误更接近失败根因。
    }
  }
  if (directoryFailure) throw directoryFailure;
  if (removeFailure) throw removeFailure;
}

async function cleanupOperations(operations: Array<() => Promise<void>>): Promise<unknown[]> {
  const results = await Promise.allSettled(operations.map((operation) => operation()));
  return results.flatMap((result) => result.status === 'rejected' ? [result.reason] : []);
}

async function applyBaseline(root: string, baseline: readonly StagedFileSnapshot[]): Promise<void> {
  const baselinePaths = new Set(baseline.map((file) => file.path));
  const tracked = await execute('git', ['-C', root, 'ls-files', '-z'], {
    windowsHide: true,
    maxBuffer: 4 * 1024 * 1024,
  });
  for (const relative of tracked.stdout.split('\0').filter(Boolean)) {
    const normalized = relative.replaceAll('\\', '/');
    if (!baselinePaths.has(normalized)) await rm(workspacePath(root, normalized), { force: true });
  }
  for (const file of baseline) {
    const target = workspacePath(root, file.path);
    await rm(target, { recursive: true, force: true });
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, file.bytes, { mode: 0o644 });
    if ((file.mode & 0o111) !== 0) await chmod(target, 0o755);
  }
}

async function workspaceChanges(
  stager: FileSystemWorkspaceStager,
  root: string,
  baseline: readonly StagedFileSnapshot[],
): Promise<string[]> {
  const current = await stager.prepare(root, `echolens-${randomUUID()}`);
  try {
    const before = new Map(baseline.map((file) => [file.path, file]));
    const after = new Map(current.baseline.map((file) => [file.path, file]));
    const paths = new Set([...before.keys(), ...after.keys()]);
    return [...paths].filter((relative) => !sameSnapshot(before.get(relative), after.get(relative))).sort();
  } finally {
    await current.cleanup();
  }
}

function sameSnapshot(left?: StagedFileSnapshot, right?: StagedFileSnapshot): boolean {
  if (!left || !right) return left === right;
  return left.bytes.equals(right.bytes) && (left.mode & 0o111) === (right.mode & 0o111);
}

function workspacePath(root: string, relative: string): string {
  const target = path.resolve(root, ...relative.split('/'));
  const within = path.relative(path.resolve(root), target);
  if (within.startsWith('..') || path.isAbsolute(within)) throw new Error('Worktree 快照路径越界');
  return target;
}

function safeMessage(error: unknown): string {
  if (error && typeof error === 'object' && 'stderr' in error && typeof error.stderr === 'string') {
    return error.stderr.trim().slice(0, 500);
  }
  return error instanceof Error ? error.message.slice(0, 500) : '未知错误';
}
