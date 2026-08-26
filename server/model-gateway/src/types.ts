import type { GatewayStateStore } from './state-store.js';

export type GatewayProtocol = 'chat_completions' | 'responses';

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

export interface GatewayUpstream {
  baseUrl: string;
  apiKey: string;
  protocol: GatewayProtocol;
  fetch?: typeof globalThis.fetch;
}

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
  deviceApprovalSecret?: string;
  entitlements?: Record<string, string[]>;
  /** The server owns and closes an injected state store with its lifecycle. */
  stateStore?: GatewayStateStore;
  models: GatewayModel[];
  upstreams: Record<string, GatewayUpstream>;
  audit?: (event: GatewayAuditEvent) => void;
  now?: () => Date;
  randomToken?: () => string;
}

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

export interface GatewayServerHandle {
  readonly baseUrl: string;
  readonly server: import('node:http').Server;
  approveDeviceCode(deviceCode: string, accountId?: string, displayName?: string): boolean;
  close(): Promise<void>;
}
