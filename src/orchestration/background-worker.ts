import { randomUUID } from 'node:crypto';
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
  onStateChange?: (task: BackgroundTaskRecord) => void | Promise<void>;
  onError?: (error: unknown) => void | Promise<void>;
}

export class BackgroundTaskWorker {
  readonly workerId: string;
  private readonly leaseMs: number;
  private readonly pollMs: number;
  private readonly active = new Map<string, AbortController>();
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
    for (const controller of this.active.values()) controller.abort('worker_stopped');
    await this.loop;
    this.loop = undefined;
  }

  async cancel(taskId: string): Promise<BackgroundTaskRecord> {
    const task = await this.queue.cancel(taskId);
    this.active.get(taskId)?.abort('task_cancelled');
    await this.notify(task);
    return task;
  }

  async runOnce(): Promise<boolean> {
    const task = await this.queue.claim(this.workerId, this.leaseMs);
    if (!task) return false;
    await this.notify(task);
    const controller = new AbortController();
    this.active.set(task.id, controller);
    // 租约约每 leaseMs/3 续租一次（下限 1s）：heartbeat 失败说明租约可能已过期或被其他 Worker 拿下，
    // 立即 abort('lease_lost') 终止本 Worker 的继续执行，避免与接管的 Worker 重复执行同一任务。
    const heartbeat = setInterval(() => {
      void this.queue.heartbeat(task.id, this.workerId, this.leaseMs).catch(() => controller.abort('lease_lost'));
    }, Math.max(1_000, Math.floor(this.leaseMs / 3)));
    try {
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
      clearInterval(heartbeat);
      this.active.delete(task.id);
    }
    return true;
  }

  // 单 Worker 轮询循环：一次只执行一个任务；执行出错仅上报后继续轮询，Worker 自身不因任务失败退出。
  private async runLoop(): Promise<void> {
    while (!this.stopped) {
      try {
        const worked = await this.runOnce();
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorCode(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') return error.code;
  return 'background_task_failed';
}
