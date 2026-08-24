import type { ConversationItem, MessageItem, ToolCallItem } from '../core/messages.js';
import type { JsonSchema } from '../runtime/types.js';

export interface ProviderCapabilities {
  maxContextTokens: number;
  supportsStreaming: boolean;
  supportsToolCalls: boolean;
  supportsParallelToolCalls: boolean;
  supportsStructuredOutput: boolean;
  supportsPromptCaching: boolean;
  supportsUsageReporting: boolean;
}

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

export interface ModelProvider {
  readonly model: string;
  readonly capabilities: ProviderCapabilities;
  complete(request: ProviderRequest): Promise<ProviderResult>;
}
