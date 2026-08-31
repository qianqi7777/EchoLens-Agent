import type { ProviderCapabilities } from '../types.js';
import type { OpenAICompatibleProtocol } from '../openai-compatible/types.js';

export type GatewayAuthState =
  | 'not_configured'
  | 'signed_out'
  | 'device_authorization_pending'
  | 'signed_in'
  | 'token_expired'
  | 'revoked'
  | 'gateway_unreachable'
  | 'entitlement_denied';

export interface GatewayAuthStatus {
  status: GatewayAuthState;
  account?: {
    id: string;
    displayName?: string;
  };
  expiresAt?: string;
}

/**
 * defaultProtocol 必须同时出现在 protocols 中，该不变量由 client.ts 解码时强制校验。
 */
export interface GatewayModelDescriptor {
  id: string;
  protocols: OpenAICompatibleProtocol[];
  defaultProtocol: OpenAICompatibleProtocol;
  capabilities: ProviderCapabilities;
}

export interface GatewayModelList {
  models: GatewayModelDescriptor[];
}

/**
 * OAuth Device Authorization Response（RFC 8628）。
 *
 * interval 为服务端建议的轮询间隔秒数；客户端应据此轮询，遇到 slow_down 时进一步放慢。
 */
export interface GatewayDeviceAuthorization {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  expiresIn: number;
  interval: number;
}

/**
 * OAuth 令牌集，包含真实的访问与刷新凭据。
 *
 * 持有时按 secrets 管理：不得写入日志、错误体或非加密的持久化位置。
 */
export interface GatewayTokenSet {
  accessToken: string;
  refreshToken?: string;
  tokenType: string;
  expiresIn: number;
  scope: string[];
}

export interface GatewayAccount {
  id: string;
  displayName?: string;
}

export type GatewayErrorCode =
  | 'invalid_request'
  | 'authentication_required'
  | 'invalid_token'
  | 'token_expired'
  | 'insufficient_scope'
  | 'model_not_allowed'
  | 'quota_exceeded'
  | 'rate_limited'
  | 'upstream_unavailable'
  | 'upstream_timeout'
  | 'upstream_response_too_large'
  | 'request_too_large'
  | 'content_blocked'
  | 'gateway_unreachable'
  | 'invalid_gateway_response'
  | 'request_cancelled'
  | 'unknown_gateway_error';
