import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  FileSystemWorkspaceStager,
  type StagedFileSnapshot,
} from '../sandbox/workspace-stager.js';
import type { BackgroundTaskIsolation } from './task-queue.js';

const execute = promisify(execFile);

/** 后台任务工作区租约：`cleanup` 必须由使用方在 finally 中调用，回收资源。 */
export interface TaskWorkspaceLease {
  id: string;
  mode: BackgroundTaskIsolation;
  root: string;
  changedFiles(): Promise<string[]>;
  cleanup(): Promise<void>;
}

export interface TaskWorkspaceAllocator {
  allocate(workspaceRoot: string, mode: BackgroundTaskIsolation): Promise<TaskWorkspaceLease>;
}

/**
 * 按隔离模式分配后台任务工作区：sandbox 用一次性暂存副本，worktree 用 git worktree。
 * 工作区分配只做隔离，不做任何业务判断；任务能否写回由调用方依据 changedFiles 决策。
 */
export class DefaultTaskWorkspaceAllocator implements TaskWorkspaceAllocator {
  constructor(private readonly stager = new FileSystemWorkspaceStager()) {}

  async allocate(workspaceRoot: string, mode: BackgroundTaskIsolation): Promise<TaskWorkspaceLease> {
    return mode === 'worktree'
      ? this.allocateWorktree(workspaceRoot)
      : this.allocateSandbox(workspaceRoot);
  }

  // sandbox 使用临时暂存副本：只读分析或运行受控测试，改动随 cleanup 丢弃，因此 changedFiles 恒为空。
  private async allocateSandbox(workspaceRoot: string): Promise<TaskWorkspaceLease> {
    const id = `echolens-${randomUUID()}`;
    const staged = await this.stager.prepare(workspaceRoot, id);
    return {
      id,
      mode: 'sandbox',
      root: staged.root,
      changedFiles: async () => [],
      cleanup: staged.cleanup,
    };
  }

  private async allocateWorktree(workspaceRoot: string): Promise<TaskWorkspaceLease> {
    const allocationId = randomUUID();
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
      changedFiles: () => workspaceChanges(this.stager, target, staged.baseline),
      cleanup: async () => {
        // cleanup 只执行一次，确保外部多次调用时也只 remove 一次 worktree 并删除目录。
        if (cleaned) return;
        await cleanupWorktree(workspaceRoot, target);
        cleaned = true;
      },
    };
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
