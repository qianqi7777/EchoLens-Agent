import type { SubagentOrchestrator, SubagentResult } from './subagent.js';
import { BackgroundTaskWorker, type BackgroundTaskExecutor } from './background-worker.js';
import {
  PersistentTaskQueue,
  type BackgroundTaskIsolation,
  type BackgroundTaskRecord,
} from './task-queue.js';

export class SubagentBackgroundService {
  readonly worker: BackgroundTaskWorker;

  constructor(
    readonly queue: PersistentTaskQueue,
    orchestrator: SubagentOrchestrator,
    onStateChange?: (task: BackgroundTaskRecord) => void | Promise<void>,
    onError?: (error: unknown) => void | Promise<void>,
    decorateObjective?: (objective: string) => string,
  ) {
    // 审批暂停与用户/预算暂停分开持久化；恢复继续同一子会话，不重新执行已完成工具。
    const executor: BackgroundTaskExecutor = {
      pause: (taskId) => orchestrator.requestPause(taskId),
      execute: async (task, signal) => {
        if ((await queue.get(task.id))?.pauseRequested) orchestrator.requestPause(task.id);
        const result = await orchestrator.run({
          taskId: task.id,
          profile: task.payload.profile,
          objective: decorateObjective?.(task.payload.objective) ?? task.payload.objective,
          workspaceMode: task.isolation,
        }, signal);
        if (result.state === 'paused') return !result.pauseReason || result.pauseReason === 'approval_required'
          ? { state: 'waiting_approval', reason: '子 Agent 等待审批', result: taskResult(result) }
          : { state: 'paused', reason: result.pauseReason ?? '子 Agent 已暂停', result: taskResult(result) };
        if (result.state === 'completed') return { state: 'completed', result: taskResult(result) };
        return { state: 'failed', code: `subagent_${result.state}`, retryable: result.state === 'cancelled' };
      },
    };
    this.worker = new BackgroundTaskWorker(queue, executor, { onStateChange, onError });
  }

  // 入队或恢复后必须唤醒 Worker 轮询，否则任务会停留在 pending 无人认领。
  async enqueue(
    profile: string,
    objective: string,
    isolation: BackgroundTaskIsolation = 'sandbox',
    metadata?: Record<string, string | number | boolean | null>,
  ): Promise<BackgroundTaskRecord> {
    const task = await this.queue.enqueue({ isolation, payload: { profile, objective, metadata } });
    await this.worker.start();
    return task;
  }

  list(): Promise<BackgroundTaskRecord[]> {
    return this.queue.list();
  }

  async workerStatus(): Promise<{ concurrency: number; running: number; pending: number }> {
    const tasks = await this.queue.list();
    return { ...this.worker.workerStatus, pending: tasks.filter((task) => task.state === 'pending').length };
  }

  setConcurrency(value: number): void {
    this.worker.setConcurrency(value);
  }

  cancel(taskId: string): Promise<BackgroundTaskRecord> {
    return this.worker.cancel(taskId);
  }

  pause(taskId: string): Promise<BackgroundTaskRecord> {
    return this.worker.pause(taskId);
  }

  async resume(taskId: string): Promise<BackgroundTaskRecord> {
    const current = await this.queue.get(taskId);
    if (!current) throw new Error(`后台任务不存在：${taskId}`);
    const task = current.state === 'pending' ? current : await this.queue.resume(taskId);
    await this.worker.start();
    return task;
  }

  close(): Promise<void> {
    return this.worker.stop();
  }
}

function taskResult(result: SubagentResult) {
  return {
    summary: result.summary,
    evidenceIds: result.evidenceIds,
    usage: result.usage,
    estimatedCost: result.estimatedCost,
    data: { subagent: result },
  };
}
