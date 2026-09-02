import type { AgentEvent } from '../../../src/session/events.js';
import type { EvalRunRecord } from './types.js';

export interface ModelPrice {
  inputPerMillion: number;
  outputPerMillion: number;
}

export interface EvalRunMetrics {
  taskId: string;
  passed: boolean;
  toolCalls: number;
  invalidToolCalls: number;
  invalidToolCallRate: number;
  modelSteps: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  modelLatencyMs: number;
  estimatedCostUsd?: number;
  approvals: number;
  approvalDenials: number;
  retries: number;
  rollbacks: number;
  humanTakeovers: number;
  promptInjectionDetections: number;
  permissionBypassAttempts: number;
}

export interface EvalAggregateMetrics {
  runs: number;
  successRate: number;
  regressionRate: number;
  averageToolCalls: number;
  invalidToolCallRate: number;
  averageModelSteps: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalLatencyMs: number;
  estimatedCostUsd?: number;
  approvals: number;
  approvalDenials: number;
  retries: number;
  rollbacks: number;
  humanTakeovers: number;
  promptInjectionDetections: number;
  permissionBypassAttempts: number;
}

export function calculateRunMetrics(
  record: EvalRunRecord,
  prices: Readonly<Record<string, ModelPrice>> = {},
): EvalRunMetrics {
  const events = record.candidate.events ?? [];
  const completedTools = events.filter((event) => event.payload.type === 'tool.completed');
  // 仅统计返回错误码为 unknown_tool / invalid_arguments / permission_denied 的已完成调用；
  // 其他失败不算无效调用，避免把运行中断当成候选质量问题。
  const invalid = completedTools.filter((event) => event.payload.type === 'tool.completed'
    && ['unknown_tool', 'invalid_arguments', 'permission_denied'].includes(event.payload.result?.error?.code ?? ''));
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedTokens = 0;
  let modelLatencyMs = 0;
  let estimatedCostUsd = 0;
  let pricedUsage = false;
  for (const event of events) {
    if (event.payload.type === 'model.completed') modelLatencyMs += event.payload.elapsedMs ?? 0;
    if (event.payload.type !== 'usage.recorded') continue;
    inputTokens += event.payload.usage.inputTokens;
    outputTokens += event.payload.usage.outputTokens;
    cachedTokens += event.payload.cachedReadTokens ?? 0;
    const price = prices[event.payload.model];
    if (price) {
      pricedUsage = true;
      estimatedCostUsd += (event.payload.usage.inputTokens * price.inputPerMillion
        + event.payload.usage.outputTokens * price.outputPerMillion) / 1_000_000;
    }
  }
  const guardrails = events.filter((event) => event.payload.type === 'guardrail.decision');
  return {
    taskId: record.taskId,
    passed: record.passed,
    toolCalls: completedTools.length,
    invalidToolCalls: invalid.length,
    invalidToolCallRate: completedTools.length ? invalid.length / completedTools.length : 0,
    modelSteps: events.filter((event) => event.payload.type === 'model.started').length,
    inputTokens,
    outputTokens,
    cachedTokens,
    modelLatencyMs,
    // 仅当至少一个模型配置了单价才返回成本，否则为 undefined，避免把“未计价”误报为 0。
    estimatedCostUsd: pricedUsage ? estimatedCostUsd : undefined,
    approvals: events.filter((event) => event.payload.type === 'approval.requested').length,
    approvalDenials: events.filter((event) => event.payload.type === 'approval.decided' && event.payload.decision === 'deny').length,
    retries: events.filter((event) => event.payload.type === 'model.retry').length,
    rollbacks: completedTools.filter((event) => event.payload.type === 'tool.completed' && event.payload.toolName === 'rollback').length,
    humanTakeovers: events.filter((event) => event.payload.type === 'turn.steered' || event.payload.type === 'run.cancelled').length,
    // 目标为工具输出且未放行（含 deny）即计为一次注入检测，代表 Guardrail 对输出做了拦截。
    promptInjectionDetections: guardrails.filter((event) => event.payload.type === 'guardrail.decision'
      && event.payload.target === 'tool_output' && event.payload.decision !== 'allow').length,
    // 只有 reasonCode 命中权限/路径/工作区/网络等类别的 deny 才计为提权绕过，
    // 用于把真正的越权尝试与普通内容拦截区分开；reasonCode 缺失或无关时不计数。
    permissionBypassAttempts: guardrails.filter((event) => event.payload.type === 'guardrail.decision'
      && event.payload.target === 'proposed_action'
      && event.payload.decision === 'deny'
      && /permission|path|workspace|network|private|git/u.test(event.payload.reasonCode)).length,
  };
}

export function aggregateMetrics(
  current: readonly EvalRunMetrics[],
  baseline: readonly EvalRunMetrics[] = [],
): EvalAggregateMetrics {
  const baselineByTask = new Map(baseline.map((metric) => [metric.taskId, metric]));
  const regressions = current.filter((metric) => baselineByTask.get(metric.taskId)?.passed && !metric.passed).length;
  const toolCalls = sum(current, (metric) => metric.toolCalls);
  const invalidCalls = sum(current, (metric) => metric.invalidToolCalls);
  const costs = current.map((metric) => metric.estimatedCostUsd).filter((value): value is number => value !== undefined);
  return {
    runs: current.length,
    successRate: ratio(current.filter((metric) => metric.passed).length, current.length),
    regressionRate: ratio(regressions, current.length),
    averageToolCalls: ratio(toolCalls, current.length),
    invalidToolCallRate: ratio(invalidCalls, toolCalls),
    averageModelSteps: ratio(sum(current, (metric) => metric.modelSteps), current.length),
    totalInputTokens: sum(current, (metric) => metric.inputTokens),
    totalOutputTokens: sum(current, (metric) => metric.outputTokens),
    totalLatencyMs: sum(current, (metric) => metric.modelLatencyMs),
    estimatedCostUsd: costs.length ? costs.reduce((total, value) => total + value, 0) : undefined,
    approvals: sum(current, (metric) => metric.approvals),
    approvalDenials: sum(current, (metric) => metric.approvalDenials),
    retries: sum(current, (metric) => metric.retries),
    rollbacks: sum(current, (metric) => metric.rollbacks),
    humanTakeovers: sum(current, (metric) => metric.humanTakeovers),
    promptInjectionDetections: sum(current, (metric) => metric.promptInjectionDetections),
    permissionBypassAttempts: sum(current, (metric) => metric.permissionBypassAttempts),
  };
}

export function event(type: AgentEvent['payload']['type'], events: AgentEvent[]): AgentEvent[] {
  return events.filter((item) => item.payload.type === type);
}

function sum(values: readonly EvalRunMetrics[], select: (value: EvalRunMetrics) => number): number {
  return values.reduce((total, value) => total + select(value), 0);
}

function ratio(value: number, total: number): number {
  return total === 0 ? 0 : value / total;
}
