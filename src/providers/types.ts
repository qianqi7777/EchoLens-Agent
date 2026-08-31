import type { ConversationItem, MessageItem, ToolCallItem } from '../core/messages.js';
import type { JsonSchema } from '../runtime/types.js';

/**
 * Provider 能力声明。运行时依赖这些标志决定是否启用流式、并行工具与结构化输出，
 * 标志与实际端点能力不符时按“关闭”处理（保守降级），而不是硬试后失败。
 */
export interface ProviderCapabilities {
  maxContextTokens: number;
  supportsStreaming: boolean;
  supportsToolCalls: boolean;
  supportsParallelToolCalls: boolean;
  supportsStructuredOutput: boolean;
  supportsPromptCaching: boolean;
  supportsUsageReporting: boolean;
}

/**
 * 停止原因分类。`retryable_error` 是唯一直接可重试的类别；
 * 其余类别决定上层是正常收尾、降级展示还是标记失败。
 */
export type ProviderStopReason =
  | 'completed'
  | 'tool_calls'
  | 'truncated'
  | 'blocked'
  | 'cancelled'
  | 'retryable_error'
  | 'fatal_error';

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cachedInputTokens?: number;
}

export interface ModelToolDefinition {
  name: string;
  description: string;
  parameters: JsonSchema;
}

export interface ProviderRequest {
  items: ConversationItem[];
  tools?: ModelToolDefinition[];
  responseFormat?: {
    name: string;
    description?: string;
    schema: JsonSchema;
    strict: true;
  };
  signal?: AbortSignal;
}

// 事件序约定：transport.retry 先于 response.started 发出，随后是内容增量事件，
// 最后以携带完整 ProviderResult 的 response.completed 结束。
export type ProviderStreamEvent =
  | { type: 'response.started'; requestId?: string }
  | { type: 'output_text.delta'; delta: string }
  | { type: 'transport.retry'; attempt: number; delayMs: number; code: string }
  | { type: 'response.completed'; result: ProviderResult };

// transport 由 Provider 客户端填充：attempts 为含首次尝试在内的总次数，
// retries = attempts - 1，仅发生重试时大于零。
export interface ProviderResult {
  output: Array<MessageItem | ToolCallItem>;
  stopReason: ProviderStopReason;
  usage?: TokenUsage;
  requestId?: string;
  cache?: {
    readTokens?: number;
    writeTokens?: number;
  };
  transport?: {
    attempts: number;
    retries: number;
    elapsedMs: number;
  };
}

/**
 * Provider 客户端边界接口。
 *
 * complete 与 stream 抛出的错误统一为 ProviderError，调用方依据 retryable 判断是否重试；
 * stream 为可选能力，调用前应以 capabilities.supportsStreaming 确认。
 */
export interface ModelProvider {
  readonly model: string;
  readonly capabilities: ProviderCapabilities;
  complete(request: ProviderRequest): Promise<ProviderResult>;
  stream?(request: ProviderRequest): AsyncIterable<ProviderStreamEvent>;
}
