import type {
  ToolError,
  ToolErrorCode,
  ToolExecutionStatus,
} from '../core/messages.js';
import type { ToolFailureResult, ToolSuccessResult } from './types.js';

export function toolSuccess(
  content: string,
  summary: string,
  evidenceIds: string[] = [],
  data?: unknown,
): ToolSuccessResult {
  return { status: 'ok', content, summary, data, evidenceIds };
}

export function toolFailure(
  status: Exclude<ToolExecutionStatus, 'ok'>,
  code: ToolErrorCode,
  message: string,
  options: { retryable?: boolean; data?: unknown; evidenceIds?: string[] } = {},
): ToolFailureResult {
  const error: ToolError = {
    code,
    message,
    retryable: options.retryable ?? false,
    data: options.data,
  };
  return {
    status,
    content: JSON.stringify({ error }),
    summary: message,
    data: options.data,
    error,
    evidenceIds: options.evidenceIds ?? [],
  };
}
