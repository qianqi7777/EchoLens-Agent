import type { ConversationItem, MessageItem, ToolCallItem } from '../core/messages.js';
import type { Permission } from '../core/permissions.js';
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

/**
 * 可选的 run 生命周期。普通 Provider 不需要实现；路由 Provider 用它在 Turn 开始时
 * 固定一个模型，避免同一条 model -> tools -> model 链路在无边界处切换模型。
 */
export interface ModelProviderRunLifecycle {
  beginRun(userMessage: string): Promise<void> | void;
  beginResume(snapshot?: ModelRoutingSnapshot): Promise<void> | void;
  snapshot(): ModelRoutingSnapshot;
  restore(snapshot: ModelRoutingSnapshot): void;
  fork(): ModelProvider & ModelProviderRunLifecycle;
  markToolsStarted(): void;
  configure(mode?: string, phase?: string): string[];
  status(): string[];
  readonly privacy: 'metadata' | 'evidence' | 'full-context';
  readonly readOnlyPhase: boolean;
  allowedPermissions(): ReadonlySet<Permission> | undefined;
  takeRouteEvents(): ModelRouteEvent[];
}

export interface ModelRoutingSnapshot {
  version: 1;
  mode: string;
  phase: 'plan' | 'execute' | 'verify';
  phaseOverride?: 'plan' | 'execute' | 'verify';
  profileId: string;
  tier: number;
  /** 仅用于恢复路径校验备用模型的工具能力；旧 checkpoint 缺省时按 true 处理。 */
  requiresTools?: boolean;
  locked: boolean;
  fallbacks: number;
  runCostUsd: number;
  sessionCostUsd: number;
  costUnknown: boolean;
}

export type ModelRouteEvent =
  | {
      type: 'selected';
      model: string;
      mode: string;
      tier: number;
      reason: string;
      candidates: string[];
      actualModel?: string;
      phase?: string;
      suggestedModel?: string;
    }
  | {
      type: 'fallback';
      fromModel: string;
      toModel: string;
      reason: string;
    }
  | {
      type: 'fallback_rejected';
      model: string;
      reason: string;
    };

export function isModelProviderRunLifecycle(
  provider: ModelProvider,
): provider is ModelProvider & ModelProviderRunLifecycle {
  const candidate = provider as Partial<ModelProviderRunLifecycle>;
  return typeof candidate.beginRun === 'function'
    && typeof candidate.beginResume === 'function'
    && typeof candidate.snapshot === 'function'
    && typeof candidate.restore === 'function'
    && typeof candidate.fork === 'function'
    && typeof candidate.markToolsStarted === 'function'
    && typeof candidate.configure === 'function'
    && typeof candidate.status === 'function'
    && typeof candidate.allowedPermissions === 'function'
    && typeof candidate.takeRouteEvents === 'function'
    && (candidate.privacy === 'metadata' || candidate.privacy === 'evidence' || candidate.privacy === 'full-context')
    && typeof candidate.readOnlyPhase === 'boolean';
}
