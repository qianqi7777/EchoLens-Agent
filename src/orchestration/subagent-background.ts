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
  ) {
    const executor: BackgroundTaskExecutor = {
      execute: async (task, signal) => {
        const result = await orchestrator.run({
          profile: task.payload.profile,
          objective: task.payload.objective,
          workspaceMode: task.isolation,
        }, signal);
        if (result.state === 'paused') return { state: 'waiting_approval', reason: '子 Agent 等待审批', result: taskResult(result) };
        if (result.state === 'completed') return { state: 'completed', result: taskResult(result) };
        return { state: 'failed', code: `subagent_${result.state}`, retryable: result.state === 'cancelled' };
      },
    };
    this.worker = new BackgroundTaskWorker(queue, executor, { onStateChange, onError });
  }

  async enqueue(profile: string, objective: string, isolation: BackgroundTaskIsolation = 'sandbox'): Promise<BackgroundTaskRecord> {
    const task = await this.queue.enqueue({ isolation, payload: { profile, objective } });
    await this.worker.start();
    return task;
  }

  list(): Promise<BackgroundTaskRecord[]> {
    return this.queue.list();
  }

  cancel(taskId: string): Promise<BackgroundTaskRecord> {
    return this.worker.cancel(taskId);
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
    data: { subagent: result },
  };
}
