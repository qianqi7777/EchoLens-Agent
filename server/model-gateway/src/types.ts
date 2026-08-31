import type { GatewayStateStore } from './state-store.js';

/** 上游模型服务支持的对话协议，决定请求/响应的编解码路径。 */
export type GatewayProtocol = 'chat_completions' | 'responses';

/**
 * 模型能力声明。客户端（Agent）据此决定是否开启并行工具调用、流式或结构化输出，
 * 服务端按该声明校验请求，避免对不支持的能力静默降级出错误结果。
 */
export interface GatewayCapabilities {
  max_context_tokens: number;
  supports_streaming: boolean;
  supports_tool_calls: boolean;
  supports_parallel_tool_calls: boolean;
  supports_structured_output: boolean;
  supports_prompt_caching: boolean;
  supports_usage_reporting: boolean;
}

export interface GatewayModel {
  id: string;
  protocols: GatewayProtocol[];
  default_protocol: GatewayProtocol;
  capabilities: GatewayCapabilities;
}

/**
 * 上游模型服务连接配置。
 *
 * `apiKey` 属于敏感凭据：只允许存在于服务端内存配置中，任何日志、审计事件或模型列表
 * 响应都不得携带该字段。
 */
export interface GatewayUpstream {
  baseUrl: string;
  apiKey: string;
  protocol: GatewayProtocol;
  fetch?: typeof globalThis.fetch;
}

/**
 * Gateway 服务端配置。
 *
 * 限流与配额（请求数/分钟、月度配额、并发上限）共同构成服务端的资源边界，任何一处
 * 超限都应优先于转发请求被拒绝。
 */
export interface GatewayServerOptions {
  host?: string;
  port?: number;
  issuer?: string;
  clientId?: string;
  deviceCodeTtlSeconds?: number;
  devicePollingIntervalSeconds?: number;
  accessTokenTtlSeconds?: number;
  refreshTokenTtlSeconds?: number;
  requestBodyLimitBytes?: number;
  maxConcurrentRequests?: number;
  maxRequestsPerMinute?: number;
  monthlyRequestQuota?: number;
  monthlyTokenQuota?: number;
  maxUpstreamDurationMs?: number;
  maxUpstreamResponseBytes?: number;
  /** 设备授权人工确认密钥。应只在受信的管理员通道下发，且不得写入日志。 */
  deviceApprovalSecret?: string;
  entitlements?: Record<string, string[]>;
  /** The server owns and closes an injected state store with its lifecycle. */
  stateStore?: GatewayStateStore;
  models: GatewayModel[];
  upstreams: Record<string, GatewayUpstream>;
  /** 审计回调。所有事件必须经过脱敏后再交给该回调。 */
  audit?: (event: GatewayAuditEvent) => void;
  now?: () => Date;
  randomToken?: () => string;
}

/**
 * 服务端审计事件。
 *
 * 审计事件只记录事件类型、账号与用量摘要，绝不包含 access token、refresh token 或上游
 * 请求体内容。
 */
export interface GatewayAuditEvent {
  type: 'device_authorization' | 'token_issued' | 'token_revoked' | 'model_request' | 'rate_limited';
  requestId: string;
  accountId?: string;
  model?: string;
  protocol?: GatewayProtocol;
  status?: number;
  elapsedMs?: number;
  inputTokens?: number;
  outputTokens?: number;
}

/** 已启动的 Gateway 服务句柄，供调用方读取地址、批准设备码或关闭服务。 */
export interface GatewayServerHandle {
  readonly baseUrl: string;
  readonly server: import('node:http').Server;
  approveDeviceCode(deviceCode: string, accountId?: string, displayName?: string): boolean;
  close(): Promise<void>;
}
