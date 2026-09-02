import assert from 'node:assert/strict';
import test from 'node:test';
import {
  executeBackgroundTaskCommand,
  type BackgroundTaskCommands,
} from '../../../../src/orchestration/task-command.js';
import type {
  BackgroundTaskIsolation,
  BackgroundTaskRecord,
} from '../../../../src/orchestration/task-queue.js';

test('后台任务命令共享解析创建、列出、取消和恢复', async () => {
  const service = new RecordingTaskCommands();
  const created = await executeBackgroundTaskCommand('/task test worktree run focused tests', service);
  assert.equal(created.handled, true);
  assert.deepEqual(service.enqueued, { profile: 'test', objective: 'run focused tests', isolation: 'worktree' });
  const taskId = service.tasks[0]!.id;
  await executeBackgroundTaskCommand(`/task cancel ${taskId}`, service);
  assert.equal(service.tasks[0]!.state, 'cancelled');
  await executeBackgroundTaskCommand(`/task resume ${taskId}`, service);
  assert.equal(service.tasks[0]!.state, 'pending');
  const listed = await executeBackgroundTaskCommand('/tasks', service);
  assert.match(listed.lines[0] ?? '', /test\/worktree/u);
});

// 用内存桩代替真实队列，只验证命令解析与参数传递，不引入持久化 I/O。
class RecordingTaskCommands implements BackgroundTaskCommands {
  readonly tasks: BackgroundTaskRecord[] = [];
  enqueued?: { profile: string; objective: string; isolation: BackgroundTaskIsolation };

  async enqueue(profile: string, objective: string, isolation: BackgroundTaskIsolation = 'sandbox') {
    this.enqueued = { profile, objective, isolation };
    const task = record(profile, objective, isolation);
    this.tasks.unshift(task);
    return structuredClone(task);
  }

  async list() {
    return structuredClone(this.tasks);
  }

  async cancel(taskId: string) {
    return this.update(taskId, 'cancelled');
  }

  async resume(taskId: string) {
    return this.update(taskId, 'pending');
  }

  private update(taskId: string, state: BackgroundTaskRecord['state']) {
    const task = this.tasks.find((item) => item.id === taskId);
    if (!task) throw new Error('missing task');
    task.state = state;
    return structuredClone(task);
  }
}

function record(profile: string, objective: string, isolation: BackgroundTaskIsolation): BackgroundTaskRecord {
  return {
    schemaVersion: 1,
    id: 'task-1',
    state: 'pending',
    isolation,
    payload: { profile, objective },
    createdAt: '2026-08-29T00:00:00.000Z',
    updatedAt: '2026-08-29T00:00:00.000Z',
    attempts: 0,
    maxAttempts: 2,
  };
}
