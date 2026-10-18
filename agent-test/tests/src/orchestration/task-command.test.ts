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
  await executeBackgroundTaskCommand(`/task pause ${taskId}`, service);
  assert.equal(service.tasks[0]!.state, 'paused');
  await executeBackgroundTaskCommand(`/task cancel ${taskId}`, service);
  assert.equal(service.tasks[0]!.state, 'cancelled');
  await executeBackgroundTaskCommand(`/task resume ${taskId}`, service);
  assert.equal(service.tasks[0]!.state, 'pending');
  const listed = await executeBackgroundTaskCommand('/tasks', service);
  assert.match(listed.lines.join('\n'), /test\/worktree/u);
  assert.match(listed.lines[0] ?? '', /Worker: 0\/2 running \| 1 queued/u);
  const changed = await executeBackgroundTaskCommand('/task concurrency 4', service);
  assert.match(changed.lines[0] ?? '', /已设为 4/u);
  assert.equal(service.concurrency, 4);
  const invalid = await executeBackgroundTaskCommand('/task concurrency 0', service);
  assert.match(invalid.lines[0] ?? '', /1 到 32/u);
});

test('后台控制命令拒绝缺失或多余参数，旧执行器不支持暂停时明确提示', async () => {
  const service = new RecordingTaskCommands();
  for (const action of ['pause', 'cancel', 'resume']) {
    for (const args of ['', 'task-1 extra']) {
      const result = await executeBackgroundTaskCommand(`/task ${action} ${args}`.trim(), service);
      assert.deepEqual(result.lines, [`用法：/task ${action} <task-id>`]);
    }
  }
  const legacy: BackgroundTaskCommands = {
    enqueue: service.enqueue.bind(service), list: service.list.bind(service),
    cancel: service.cancel.bind(service), resume: service.resume.bind(service),
  };
  assert.deepEqual((await executeBackgroundTaskCommand('/task pause task-1', legacy)).lines, ['当前后台执行器不支持安全点暂停']);
  assert.deepEqual((await executeBackgroundTaskCommand('/task concurrency 2', legacy)).lines, ['Worker 并发配置不可用。']);
  assert.deepEqual((await executeBackgroundTaskCommand('/tasks', legacy)).lines, ['暂无后台任务。']);
  assert.deepEqual(service.tasks, []);
});

test('后台命令查询和错误输入保持只读，不意外创建任务', async () => {
  const service = new RecordingTaskCommands();
  assert.deepEqual(await executeBackgroundTaskCommand('ordinary prompt', service), { handled: false, lines: [] });
  for (const input of ['/task', '/task help']) {
    assert.ok((await executeBackgroundTaskCommand(input, service)).lines.includes('/task pause <task-id>：在工具批次安全点暂停任务'));
  }
  assert.match((await executeBackgroundTaskCommand('/task concurrency', service)).lines.join('\n'), /当前 Worker 并发：2/u);
  assert.match((await executeBackgroundTaskCommand('/task unknown goal', service)).lines[0]!, /未知 Profile/u);
  assert.match((await executeBackgroundTaskCommand('/task explore sandbox', service)).lines[0]!, /用法/u);
  assert.deepEqual((await executeBackgroundTaskCommand('/usage one two', service)).lines, ['用法：/usage [session-id]']);
  assert.deepEqual(service.tasks, []);
});

test('后台创建失败保持 Sandbox 预检提示，其他错误不伪装成已创建', async () => {
  const service = new RecordingTaskCommands();
  service.enqueue = async () => { throw Object.assign(new Error('not ready'), { code: 'sandbox_setup_required' }); };
  assert.match((await executeBackgroundTaskCommand('/task test run checks', service)).lines[0]!, /sandbox_setup_required/u);
  service.enqueue = async () => { throw new Error('queue unavailable'); };
  await assert.rejects(executeBackgroundTaskCommand('/task explore inspect', service), /queue unavailable/u);
  assert.deepEqual(service.tasks, []);
});

// 用内存桩代替真实队列，只验证命令解析与参数传递，不引入持久化 I/O。
class RecordingTaskCommands implements BackgroundTaskCommands {
  readonly tasks: BackgroundTaskRecord[] = [];
  enqueued?: { profile: string; objective: string; isolation: BackgroundTaskIsolation };
  concurrency = 2;

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

  async pause(taskId: string) {
    return this.update(taskId, 'paused');
  }

  async resume(taskId: string) {
    return this.update(taskId, 'pending');
  }

  async workerStatus() {
    return { concurrency: this.concurrency, running: 0, pending: this.tasks.filter((task) => task.state === 'pending').length };
  }

  setConcurrency(value: number) {
    if (!Number.isInteger(value) || value < 1 || value > 32) throw new Error('Worker concurrency 必须是 1 到 32 的整数');
    this.concurrency = value;
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
