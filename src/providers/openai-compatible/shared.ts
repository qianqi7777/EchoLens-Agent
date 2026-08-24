import type { ToolCallItem } from '../../core/messages.js';
import type { ProviderStopReason } from '../types.js';

export interface ParsedArguments {
  arguments: Record<string, unknown>;
  rawArguments: string;
  argumentParseError?: string;
}

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
