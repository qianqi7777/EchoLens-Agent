import { randomUUID } from 'node:crypto';
import {
  isMessageItem,
  isToolCallItem,
  messageText,
  textMessage,
  type ConversationItem,
  type ToolResultItem,
} from '../core/messages.js';
import { systemPolicyMessage } from '../core/system-policy.js';
import type { ModelProvider, ModelToolDefinition } from '../providers/types.js';
import { ToolExecutor } from './tool-executor.js';
import { ToolRegistry } from './tool-registry.js';
import { createToolOutputContextItem } from './tool-output.js';
import {
  FINAL_SUMMARY_FORMAT,
  parseFinalSummary,
  type StructuredOutputResult,
  type FinalSummary,
} from './structured-output.js';
import type { AgentTraceItem, Permission, ToolContext } from './types.js';

export interface AgentRunResult {
  answer: string;
  items: ConversationItem[];
  trace: AgentTraceItem[];
  degraded: boolean;
  finalSummary: StructuredOutputResult<FinalSummary>;
}

export interface ReactAgentOptions {
  maxSteps?: number;
  maxHistoryTurns?: number;
  workspaceRoot: string;
  permissions?: ReadonlySet<Permission>;
}

/**
 * 最小 ReAct 回合：模型决定是否调用工具，工具结果回填 messages，直到模型给出最终答案。
 * 这是一个可替换的工作流实现，不把 Session、权限或工具安全塞进模型框架 State。
 */
export class ReactAgent {
  constructor(
    private readonly model: ModelProvider,
    private readonly registry: ToolRegistry,
    private readonly executor: ToolExecutor,
    private readonly options: ReactAgentOptions,
  ) {}

  async run(userMessage: string, history: ConversationItem[] = [], signal?: AbortSignal): Promise<AgentRunResult> {
    const runId = randomUUID();
    let nextItem = 0;
    const itemId = (kind: string) => `${runId}:${kind}:${nextItem += 1}`;
    const safeHistory = recentUserTurns(history, this.options.maxHistoryTurns ?? 3);
    const items: ConversationItem[] = [
      systemPolicyMessage(),
      ...safeHistory,
      textMessage(itemId('message'), 'user', userMessage),
    ];
    const trace: AgentTraceItem[] = [];
    const registeredTools: ModelToolDefinition[] = this.registry.list().map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    }));
    const tools = this.model.capabilities.supportsToolCalls && registeredTools.length > 0
      ? registeredTools
      : undefined;
    const context: ToolContext = { workspaceRoot: this.options.workspaceRoot, allowedPermissions: this.options.permissions ?? new Set(['workspace.read']), signal: signal ?? new AbortController().signal };
    this.executor.resetBudget();

    for (let step = 0; step < (this.options.maxSteps ?? 8); step += 1) {
      const response = await this.model.complete({
        items,
        tools,
        responseFormat: this.model.capabilities.supportsStructuredOutput
          ? FINAL_SUMMARY_FORMAT
          : undefined,
        signal,
      });
      const toolCalls = response.output.filter(isToolCallItem);
      items.push(...response.output);
      trace.push({ type: 'model', message: toolCalls.length ? `模型请求 ${toolCalls.length} 个工具` : '模型生成最终回答' });
      if (toolCalls.length === 0) {
        const answer = assistantText(response.output);
        if (response.stopReason === 'completed') return finishRun(answer, items, trace, false);
        const fallback = answer || stopReasonMessage(response.stopReason);
        trace.push({ type: 'warning', message: `模型未正常完成：${response.stopReason}` });
        return finishRun(fallback, items, trace, true);
      }
      if (response.stopReason !== 'tool_calls' && response.stopReason !== 'completed') {
        trace.push({ type: 'warning', message: `模型返回工具调用，但停止原因是 ${response.stopReason}` });
        return finishRun(stopReasonMessage(response.stopReason), items, trace, true);
      }

      for (const call of toolCalls) {
        const result = await this.executor.invoke(call.name, call.arguments, context);
        const output = createToolOutputContextItem(itemId('context'), call, result);
        const toolResult: ToolResultItem = {
          type: 'tool_result',
          id: itemId('tool-result'),
          callId: call.callId,
          toolName: call.name,
          status: result.status,
          output,
          summary: result.summary,
          data: result.data,
          error: result.error,
          outputMetadata: result.outputMetadata,
          evidenceIds: result.evidenceIds,
        };
        items.push(toolResult);
        trace.push({ type: 'tool', message: `${call.name}: ${result.summary}` });
      }
    }
    return finishRun('已达到 Agent 步骤预算，以上工具结果仍需人工核查。', items, trace, true);
  }
}

function recentUserTurns(history: readonly ConversationItem[], maxTurns: number): ConversationItem[] {
  const items = history.filter((item) => item.type !== 'message' || item.role !== 'system');
  const starts = items.flatMap((item, index) => (
    item.type === 'message' && item.role === 'user' ? [index] : []
  ));
  if (starts.length === 0 || maxTurns <= 0) return [];
  return items.slice(starts[Math.max(0, starts.length - maxTurns)]);
}

function assistantText(items: readonly ConversationItem[]): string {
  return items
    .filter(isMessageItem)
    .filter((item) => item.role === 'assistant')
    .map(messageText)
    .join('');
}

function finishRun(
  rawAnswer: string,
  items: ConversationItem[],
  trace: AgentTraceItem[],
  degraded: boolean,
): AgentRunResult {
  const finalSummary = parseFinalSummary(rawAnswer);
  return {
    answer: finalSummary.verified ? finalSummary.value.answer : rawAnswer,
    items,
    trace,
    degraded,
    finalSummary,
  };
}

function stopReasonMessage(reason: string): string {
  const messages: Record<string, string> = {
    tool_calls: '模型声明了工具调用，但没有返回可执行的工具请求。',
    truncated: '模型输出因长度限制而未完成。',
    blocked: '模型输出被内容策略阻止。',
    cancelled: '模型请求已取消。',
    retryable_error: '模型服务暂时不可用，可稍后重试。',
    fatal_error: '模型服务返回不可恢复错误。',
  };
  return messages[reason] ?? `模型未正常完成：${reason}`;
}
