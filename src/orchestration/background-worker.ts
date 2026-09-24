import { randomUUID } from 'node:crypto';
import os from 'node:os';
import type {
  BackgroundTaskRecord,
  BackgroundTaskResult,
  PersistentTaskQueue,
} from './task-queue.js';

export type BackgroundExecutionResult =
  | { state: 'completed'; result: BackgroundTaskResult }
  | { state: 'waiting_approval'; reason: string; result?: BackgroundTaskResult }
  | { state: 'failed'; code: string; retryable: boolean };

export interface BackgroundTaskExecutor {
  execute(task: BackgroundTaskRecord, signal: AbortSignal): Promise<BackgroundExecutionResult>;
}

export interface BackgroundWorkerOptions {
  workerId?: string;
  leaseMs?: number;
  pollMs?: number;
  concurrency?: number;
  onStateChange?: (task: BackgroundTaskRecord) => void | Promise<void>;
  onError?: (error: unknown) => void | Promise<void>;
}

export class BackgroundTaskWorker {
  readonly workerId: string;
  private readonly leaseMs: number;
  private readonly pollMs: number;
  private concurrency: number;
  private readonly active = new Map<string, { controller: AbortController; workspaceKey: string; execution?: Promise<void> }>();
  private stopped = false;
  private loop?: Promise<void>;

  constructor(
    private readonly queue: PersistentTaskQueue,
    private readonly executor: BackgroundTaskExecutor,
    private readonly options: BackgroundWorkerOptions = {},
  ) {
    this.workerId = options.workerId ?? `worker-${randomUUID()}`;
    this.leaseMs = options.leaseMs ?? 60_000;
    this.pollMs = options.pollMs ?? 500;
    this.concurrency = options.concurrency ?? defaultConcurrency(process.env.AGENT_WORKER_CONCURRENCY);
    validateConcurrency(this.concurrency);
  }

  get workerStatus(): { concurrency: number; running: number } {
    return { concurrency: this.concurrency, running: this.active.size };
  }

  setConcurrency(value: number): void {
    validateConcurrency(value);
    this.concurrency = value;
  }

  async start(): Promise<void> {
    if (this.loop) return;
    this.stopped = false;
    await this.queue.recoverExpired();
    this.loop = this.runLoop();
  }

  // 停止：中止所有在跑任务并等待轮询循环收敛；被中止的 running 任务经 settleAborted 释放回 pending。
  async stop(): Promise<void> {
    this.stopped = true;
    for (const task of this.active.values()) task.controller.abort('worker_stopped');
    await this.loop;
    await Promise.allSettled([...this.active.values()].flatMap((task) => task.execution ? [task.execution] : []));
    this.loop = undefined;
  }

  async cancel(taskId: string): Promise<BackgroundTaskRecord> {
    const task = await this.queue.cancel(taskId);
    this.active.get(taskId)?.controller.abort('task_cancelled');
    await this.notify(task);
    return task;
  }

  async runOnce(): Promise<boolean> {
    const started = await this.startNext();
    if (!started) return false;
    await started.execution;
    return true;
  }

  private async startNext(): Promise<{ execution: Promise<void> } | undefined> {
    if (this.active.size >= this.concurrency) return undefined;
    const task = await this.queue.claimNext(this.workerId, {
      leaseMs: this.leaseMs,
      excludeWorkspaces: [...this.active.values()].map((item) => item.workspaceKey),
    });
    if (!task) return undefined;
    if (this.stopped) {
      await this.queue.release(task.id, this.workerId);
      return undefined;
    }
    // Public runOnce callers may race each other outside the internal poll loop. Recheck
    // capacity after the serialized queue claim and release excess claims without failure.
    if (this.active.size >= this.concurrency) {
      await this.queue.release(task.id, this.workerId);
      return undefined;
    }
    const controller = new AbortController();
    const activeTask: { controller: AbortController; workspaceKey: string; execution?: Promise<void> } = {
      controller, workspaceKey: declaredWorkspaceKey(task),
    };
    this.active.set(task.id, activeTask);
    const execution = this.executeClaimed(task, controller).catch(async (error) => {
      await this.reportError(error);
    });
    activeTask.execution = execution;
    return { execution };
  }

  private async executeClaimed(task: BackgroundTaskRecord, controller: AbortController): Promise<void> {
    let heartbeat: NodeJS.Timeout | undefined;
    try {
      await this.notify(task);
      if (controller.signal.aborted) {
        await this.notify(await this.settleAborted(task.id, controller.signal.reason));
        return;
      }
      // 租约约每 leaseMs/3 续租一次（下限 1s）：heartbeat 失败说明租约可能已过期或被其他 Worker 拿下，
      // 立即 abort('lease_lost') 终止本 Worker 的继续执行，避免与接管的 Worker 重复执行同一任务。
      heartbeat = setInterval(() => {
        void this.queue.heartbeat(task.id, this.workerId, this.leaseMs).catch(() => controller.abort('lease_lost'));
      }, Math.max(1_000, Math.floor(this.leaseMs / 3)));
      const result = await this.executor.execute(task, controller.signal);
      let updated: BackgroundTaskRecord;
      if (controller.signal.aborted) updated = await this.settleAborted(task.id, controller.signal.reason);
      else if (result.state === 'completed') updated = await this.queue.complete(task.id, this.workerId, result.result);
      else if (result.state === 'waiting_approval') {
        updated = await this.queue.waitForApproval(task.id, this.workerId, result.reason, result.result);
      } else updated = await this.queue.fail(task.id, this.workerId, result.code, result.retryable);
      await this.notify(updated);
    } catch (error) {
      const updated = controller.signal.aborted
        ? await this.settleAborted(task.id, controller.signal.reason)
        : await this.queue.fail(task.id, this.workerId, errorCode(error), true);
      await this.notify(updated);
    } finally {
      if (heartbeat) clearInterval(heartbeat);
      this.active.delete(task.id);
    }
  }

  // 池内每个执行仍是独立异步任务；单次扫描只认领到 concurrency 上限，失败只影响当前任务。
  private async runLoop(): Promise<void> {
    while (!this.stopped) {
      try {
        let worked = false;
        while (!this.stopped && this.active.size < this.concurrency) {
          const started = await this.startNext();
          if (!started) break;
          worked = true;
        }
        if (!worked) await delay(this.pollMs);
      } catch (error) {
        await this.reportError(error);
        if (!this.stopped) await delay(this.pollMs);
      }
    }
  }

  private async notify(task: BackgroundTaskRecord): Promise<void> {
    try {
      await this.options.onStateChange?.(task);
    } catch (error) {
      await this.reportError(error);
    }
  }

  private async reportError(error: unknown): Promise<void> {
    try {
      await this.options.onError?.(error);
    } catch {
      // Notification failures must not stop task execution or the worker loop.
    }
  }

  // 按 abort 原因归属终态：用户取消→cancelled；Worker 正常停止→release 回 pending 以便显式恢复；
  // 其余（lease_lost/中断）标记为可重试失败，交还给队列重排。
  private async settleAborted(taskId: string, reason: unknown): Promise<BackgroundTaskRecord> {
    if (reason === 'task_cancelled') return this.queue.cancel(taskId);
    if (reason === 'worker_stopped') return this.queue.release(taskId, this.workerId);
    try {
      return await this.queue.fail(taskId, this.workerId, 'background_task_interrupted', true);
    } catch {
      const current = await this.queue.get(taskId);
      if (current) return current;
      throw new Error(`后台任务不存在：${taskId}`);
    }
  }
}

function defaultConcurrency(value: string | undefined): number {
  const fallback = Math.min(32, Math.max(1, Math.floor(os.cpus().length / 2)));
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number(value);
  validateConcurrency(parsed);
  return parsed;
}

function validateConcurrency(value: number): void {
  if (!Number.isInteger(value) || value < 1 || value > 32) {
    throw new Error('Worker concurrency 必须是 1 到 32 的整数');
  }
}

function declaredWorkspaceKey(task: BackgroundTaskRecord): string {
  const key = task.payload.metadata?.workspaceKey;
  return typeof key === 'string' && key.trim() ? key.trim() : `task:${task.id}`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorCode(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') return error.code;
  return 'background_task_failed';
}
