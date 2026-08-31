import type { ToolCallItem } from '../../core/messages.js';
import type { ProviderStopReason } from '../types.js';

/**
 * 工具参数解析结果。
 *
 * `rawArguments` 保留 Provider 原始字符串（回填消息时原样回传，避免二次序列化改变内容）；
 * 解析失败时 `arguments` 回退为空对象并给出错误说明。
 */
export interface ParsedArguments {
  arguments: Record<string, unknown>;
  rawArguments: string;
  argumentParseError?: string;
}

// Provider 返回的工具参数不可信：容错解析，非法或被截断的 JSON 不直接中断 Turn，
// 而是回退为空对象并记录 argumentParseError，由调用方据此判定该工具调用失败。
export function parseToolArguments(raw: string): ParsedArguments {
  try {
    const value = JSON.parse(raw) as unknown;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return { arguments: value as Record<string, unknown>, rawArguments: raw };
    }
    return {
      arguments: {},
      rawArguments: raw,
      argumentParseError: '工具参数必须是 JSON 对象',
    };
  } catch {
    return {
      arguments: {},
      rawArguments: raw,
      argumentParseError: '工具参数不是合法 JSON',
    };
  }
}

export function toolCallItem(
  id: string,
  callId: string,
  name: string,
  rawArguments: string,
  callIndex: number,
): ToolCallItem {
  return {
    type: 'tool_call',
    id,
    callId,
    name,
    callIndex,
    ...parseToolArguments(rawArguments),
  };
}

// Chat Completions finish_reason 到内置停止原因的映射。insufficient_system_resource 是唯一
// 明确可重试的终止原因，映射为 retryable_error；未识别的 reason 默认按 completed 处理，
// 不把未知终止态升级为错误，为未列出的 Provider 保留默认成功路径。
export function stopReasonFromChat(reason: string | null | undefined, hasToolCalls: boolean): ProviderStopReason {
  if (hasToolCalls || reason === 'tool_calls') return 'tool_calls';
  if (reason === 'length') return 'truncated';
  if (reason === 'content_filter') return 'blocked';
  if (reason === 'insufficient_system_resource') return 'retryable_error';
  return 'completed';
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function nonNegativeNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}
