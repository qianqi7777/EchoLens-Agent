import type {
  BackgroundTaskIsolation,
  BackgroundTaskRecord,
} from './task-queue.js';

/** 后台任务命令的界面接口：CLI 与 TUI 共用同一组操作，便于两处行为一致。 */
export interface BackgroundTaskCommands {
  enqueue(profile: string, objective: string, isolation?: BackgroundTaskIsolation): Promise<BackgroundTaskRecord>;
  list(): Promise<BackgroundTaskRecord[]>;
  cancel(taskId: string): Promise<BackgroundTaskRecord>;
  resume(taskId: string): Promise<BackgroundTaskRecord>;
}

export interface BackgroundTaskCommandResult {
  handled: boolean;
  lines: string[];
}

/** 以 `/tasks` 或 `/task ...` 开头才视为后台任务命令，其余输入一律不拦截。 */
export function isBackgroundTaskCommand(input: string): boolean {
  return input === '/tasks' || input === '/task' || input.startsWith('/task ');
}

/**
 * 解析并执行后台任务命令，产出给终端展示的多行文本。
 * @returns handled=false 表示输入不是后台任务命令，调用方应继续按普通消息处理。
 */
export async function executeBackgroundTaskCommand(
  input: string,
  service: BackgroundTaskCommands,
): Promise<BackgroundTaskCommandResult> {
  if (!isBackgroundTaskCommand(input)) return { handled: false, lines: [] };
  const parts = input.trim().split(/\s+/u);
  if (parts[0] === '/tasks') {
    const tasks = await service.list();
    return {
      handled: true,
      lines: tasks.length ? tasks.slice(0, 20).map(formatBackgroundTask) : ['暂无后台任务。'],
    };
  }
  const action = parts[1];
  if (!action || action === 'help') return { handled: true, lines: taskHelp() };
  if (action === 'cancel' || action === 'resume') {
    const taskId = parts[2];
    if (!taskId) return { handled: true, lines: [`用法：/task ${action} <task-id>`] };
    const task = action === 'cancel' ? await service.cancel(taskId) : await service.resume(taskId);
    return { handled: true, lines: [formatBackgroundTask(task)] };
  }
  if (action !== 'explore' && action !== 'test' && action !== 'review') {
    return { handled: true, lines: [`未知 Profile：${action}`, ...taskHelp()] };
  }
  let objectiveIndex = 2;
  let isolation: BackgroundTaskIsolation = 'sandbox';
  // 第 3 个 token 若为 sandbox/worktree 则作为隔离选项，其余部分视为目标文本。
  if (parts[2] === 'sandbox' || parts[2] === 'worktree') {
    isolation = parts[2];
    objectiveIndex = 3;
  }
  const objective = parts.slice(objectiveIndex).join(' ').trim();
  if (!objective) {
    return { handled: true, lines: ['用法：/task <explore|test|review> [sandbox|worktree] <目标>'] };
  }
  const task = await service.enqueue(action, objective, isolation);
  return { handled: true, lines: [`已创建后台任务：${formatBackgroundTask(task)}`] };
}

export function formatBackgroundTask(task: BackgroundTaskRecord): string {
  const detail = task.waitingReason ?? task.errorCode ?? task.result?.summary;
  const suffix = detail ? ` | ${singleLine(detail, 120)}` : '';
  return `${task.id} | ${task.state} | ${task.payload.profile}/${task.isolation} | attempts=${task.attempts}/${task.maxAttempts}${suffix}`;
}

function taskHelp(): string[] {
  return [
    '/tasks：列出最近后台任务',
    '/task <explore|test|review> [sandbox|worktree] <目标>：创建并启动任务',
    '/task cancel <task-id>：取消任务',
    '/task resume <task-id>：显式恢复任务',
  ];
}

function singleLine(value: string, maxLength: number): string {
  // 把换行/Tab 折叠为空格并截断到单行，防止任务摘要中的控制字符注入终端输出。
  const normalized = value.replace(/[\r\n\t]+/gu, ' ').trim();
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 1)}…`;
}
