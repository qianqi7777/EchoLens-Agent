import type {
  BackgroundTaskEstimatedCost,
  BackgroundTaskIsolation,
  BackgroundTaskRecord,
  BackgroundTaskUsage,
} from './task-queue.js';

/** 后台任务命令的界面接口：CLI 与 TUI 共用同一组操作，便于两处行为一致。 */
export interface BackgroundTaskCommands {
  enqueue(profile: string, objective: string, isolation?: BackgroundTaskIsolation, metadata?: Record<string, string | number | boolean | null>): Promise<BackgroundTaskRecord>;
  list(): Promise<BackgroundTaskRecord[]>;
  cancel(taskId: string): Promise<BackgroundTaskRecord>;
  resume(taskId: string): Promise<BackgroundTaskRecord>;
  workerStatus?(): Promise<{ concurrency: number; running: number; pending: number }>;
  setConcurrency?(value: number): void;
}

export interface BackgroundTaskCommandResult {
  handled: boolean;
  lines: string[];
}

/** 以 `/tasks` 或 `/task ...` 开头才视为后台任务命令，其余输入一律不拦截。 */
export function isBackgroundTaskCommand(input: string): boolean {
  return input === '/tasks' || input === '/usage' || input.startsWith('/usage ')
    || input === '/task' || input.startsWith('/task ');
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
  if (parts[0] === '/usage') {
    if (parts.length > 2) return { handled: true, lines: ['用法：/usage [session-id]'] };
    const tasks = await service.list();
    return { handled: true, lines: formatUsageSummary(tasks, parts[1]) };
  }
  if (parts[0] === '/tasks') {
    const tasks = await service.list();
    const status = await service.workerStatus?.();
    return {
      handled: true,
      lines: [
        ...(status ? [`Worker: ${status.running}/${status.concurrency} running | ${status.pending} queued`] : []),
        ...(tasks.length ? tasks.slice(0, 20).map(formatBackgroundTask) : ['暂无后台任务。']),
      ],
    };
  }
  const action = parts[1];
  if (!action || action === 'help') return { handled: true, lines: taskHelp() };
  if (action === 'concurrency') {
    if (!service.setConcurrency || !service.workerStatus) return { handled: true, lines: ['Worker 并发配置不可用。'] };
    if (parts.length !== 3 || !/^\d+$/u.test(parts[2] ?? '')) {
      const status = await service.workerStatus();
      return { handled: true, lines: [`当前 Worker 并发：${status.concurrency}（${status.running} running，${status.pending} queued）`, '用法：/task concurrency <1-32>'] };
    }
    const concurrency = Number(parts[2]);
    try { service.setConcurrency(concurrency); } catch (error) {
      return { handled: true, lines: [error instanceof Error ? error.message : '并发值无效'] };
    }
    const status = await service.workerStatus();
    return { handled: true, lines: [`Worker 并发已设为 ${status.concurrency}（${status.running} running，${status.pending} queued）`] };
  }
  if (action === 'cancel' || action === 'resume') {
    const taskId = parts[2];
    if (!taskId || parts.length !== 3) return { handled: true, lines: [`用法：/task ${action} <task-id>`] };
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
  const usage = task.usage ? ` | ${formatUsage(task.usage)} cost=${formatCost(task.estimatedCost)}` : '';
  return `${task.id} | ${task.state} | ${task.payload.profile}/${task.isolation} | attempts=${task.attempts}/${task.maxAttempts}${usage}${suffix}`;
}

export function formatUsageSummary(tasks: readonly BackgroundTaskRecord[], sessionId?: string): string[] {
  const selected = sessionId
    ? tasks.filter((task) => task.payload.metadata?.sessionId === sessionId)
    : tasks;
  const withUsage = selected.filter((task) => task.usage);
  if (withUsage.length === 0) return [sessionId ? `会话 ${sessionId} 暂无用量记录。` : '暂无用量记录。'];
  const lines = [sessionId ? `会话用量：${sessionId}` : '任务用量：'];
  lines.push(...withUsage.map((task) => `${task.id} | ${task.payload.profile} | ${formatUsage(task.usage!)} cost=${formatCost(task.estimatedCost)}`));
  const sessionTotals = new Map<string, UsageAccumulator>();
  for (const task of withUsage) {
    const key = typeof task.payload.metadata?.sessionId === 'string'
      && task.payload.metadata.sessionId.trim() ? task.payload.metadata.sessionId : 'unknown';
    const current = sessionTotals.get(key) ?? emptyUsage();
    addUsage(current, task.usage!);
    addCost(current, task.estimatedCost);
    sessionTotals.set(key, current);
  }
  lines.push('会话汇总：');
  for (const [key, total] of sessionTotals) {
    lines.push(`${key} | tasks=${total.tasks} | ${formatUsage(total)} cost=${formatCost(total.cost)}`);
  }
  return lines;
}

function taskHelp(): string[] {
  return [
    '/tasks：列出最近后台任务',
    '/usage [session-id]：汇总后台任务 token、步骤、工具调用和成本',
    '/task concurrency <1-32>：设置 Worker 池并发上限',
    '/task <explore|test|review> [sandbox|worktree] <目标>：创建并启动任务',
    '/task cancel <task-id>：取消任务',
    '/task resume <task-id>：显式恢复任务',
  ];
}

interface UsageAccumulator extends BackgroundTaskUsage {
  tasks: number;
  cost?: BackgroundTaskEstimatedCost;
}

function emptyUsage(): UsageAccumulator {
  return { inputTokens: 0, outputTokens: 0, cachedTokens: 0, modelSteps: 0, toolCalls: 0, tasks: 0 };
}

function addUsage(target: UsageAccumulator, usage: BackgroundTaskUsage): void {
  target.inputTokens += usage.inputTokens;
  target.outputTokens += usage.outputTokens;
  target.cachedTokens = (target.cachedTokens ?? 0) + (usage.cachedTokens ?? 0);
  target.modelSteps += usage.modelSteps;
  target.toolCalls += usage.toolCalls;
  target.tasks += 1;
}

function addCost(target: UsageAccumulator, cost: BackgroundTaskEstimatedCost | undefined): void {
  if (!cost) return;
  if ('unknown' in cost) {
    target.cost = { unknown: true };
    return;
  }
  if (target.cost && 'unknown' in target.cost) return;
  if (!target.cost) target.cost = { amount: 0, currency: cost.currency };
  if ('amount' in target.cost && target.cost.currency === cost.currency) target.cost.amount += cost.amount;
  else target.cost = { unknown: true };
}

function formatUsage(usage: BackgroundTaskUsage & { tasks?: number }): string {
  return `input=${usage.inputTokens} output=${usage.outputTokens} cached=${usage.cachedTokens ?? 0} steps=${usage.modelSteps} tools=${usage.toolCalls}`;
}

function formatCost(cost: BackgroundTaskEstimatedCost | undefined): string {
  if (!cost || 'unknown' in cost) return 'unknown';
  return `${cost.currency} ${cost.amount.toFixed(6)}`;
}

function singleLine(value: string, maxLength: number): string {
  // 把换行/Tab 折叠为空格并截断到单行，防止任务摘要中的控制字符注入终端输出。
  const normalized = value.replace(/[\r\n\t]+/gu, ' ').trim();
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 1)}…`;
}
