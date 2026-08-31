import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { FileSystemWorkspaceStager } from '../sandbox/workspace-stager.js';
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
    const id = `echolens-worktree-${randomUUID()}`;
    // --detach：只检出 HEAD 生成隔离副本，不在源仓库创建新分支、不触碰当前 checked-out 分支。
    // 目录按 workspace 根路径哈希分桶，同一工作区并发任务再用 uuid 区分，避免子 Agent 互相碰撞。
    const rootHash = createHash('sha256').update(path.resolve(workspaceRoot)).digest('hex').slice(0, 12);
    const base = path.join(os.tmpdir(), 'echolens-worktrees', rootHash);
    const target = path.join(base, id);
    await mkdir(base, { recursive: true });
    try {
      await execute('git', ['-C', workspaceRoot, 'worktree', 'add', '--detach', target, 'HEAD'], {
        windowsHide: true,
        maxBuffer: 4 * 1024 * 1024,
      });
    } catch (error) {
      await rm(target, { recursive: true, force: true }).catch(() => undefined);
      throw new Error(`无法创建后台 Worktree：${safeMessage(error)}`);
    }
    let cleaned = false;
    return {
      id,
      mode: 'worktree',
      root: target,
      changedFiles: () => worktreeChanges(target),
      cleanup: async () => {
        // cleanup 只执行一次，确保外部多次调用时也只 remove 一次 worktree 并删除目录。
        if (cleaned) return;
        cleaned = true;
        try {
          await execute('git', ['-C', workspaceRoot, 'worktree', 'remove', '--force', target], {
            windowsHide: true,
            maxBuffer: 4 * 1024 * 1024,
          });
        } finally {
          await rm(target, { recursive: true, force: true }).catch(() => undefined);
        }
      },
    };
  }
}

async function worktreeChanges(root: string): Promise<string[]> {
  const result = await execute('git', ['-C', root, 'status', '--porcelain=v1', '-z'], {
    windowsHide: true,
    maxBuffer: 4 * 1024 * 1024,
  });
  const entries = result.stdout.split('\0').filter(Boolean);
  const changed: string[] = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!;
    const status = entry.slice(0, 2);
    changed.push(entry.slice(3).replaceAll('\\', '/'));
    // porcelain v1 中 rename/copy 会输出源与目标两条记录，这里跳过紧随其后的记录，避免路径统计重复。
    if (/[RC]/u.test(status)) index += 1;
  }
  return [...new Set(changed)].sort();
}

function safeMessage(error: unknown): string {
  if (error && typeof error === 'object' && 'stderr' in error && typeof error.stderr === 'string') {
    return error.stderr.trim().slice(0, 500);
  }
  return error instanceof Error ? error.message.slice(0, 500) : '未知错误';
}
