import { redactText, redactValue, safeProviderDetails } from '../redaction.js';
import { createRequestSignal } from '../request-signal.js';
import { parseRetryAfter } from '../retry-policy.js';
import type { ProviderCapabilities } from '../types.js';
import type { OpenAICompatibleProtocol } from '../openai-compatible/types.js';
import type {
  GatewayAuthState,
  GatewayAuthStatus,
  GatewayAccount,
  GatewayDeviceAuthorization,
  GatewayErrorCode,
  GatewayModelDescriptor,
  GatewayModelList,
  GatewayTokenSet,
} from './types.js';

export interface GatewayClientOptions {
  gatewayUrl: string;
  accessToken: string;
  fetch?: typeof globalThis.fetch;
  requestTimeoutMs?: number;
}

export interface GatewayClientErrorOptions {
  code: GatewayErrorCode;
  message: string;
  retryable: boolean;
  status?: number;
  requestId?: string;
  retryAfterMs?: number;
  cause?: unknown;
}

export class GatewayClientError extends Error {
  readonly code: GatewayErrorCode;
  readonly retryable: boolean;
  readonly status?: number;
  readonly requestId?: string;
  readonly retryAfterMs?: number;

  constructor(options: GatewayClientErrorOptions) {
    super(redactText(options.message), {
      cause: options.cause === undefined ? undefined : redactValue(options.cause),
    });
    this.name = 'GatewayClientError';
    this.code = options.code;
    this.retryable = options.retryable;
    this.status = options.status;
    this.requestId = options.requestId ? redactText(options.requestId) : undefined;
    this.retryAfterMs = options.retryAfterMs;
  }
}

export class GatewayClient {
  private readonly gatewayUrl: string;
  private readonly fetchImplementation: typeof globalThis.fetch;
  private readonly requestTimeoutMs: number;

  constructor(private readonly options: GatewayClientOptions) {
    this.gatewayUrl = options.gatewayUrl.replace(/\/$/, '');
    this.fetchImplementation = options.fetch ?? globalThis.fetch;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
  }

  async authStatus(signal?: AbortSignal): Promise<GatewayAuthStatus> {
    return decodeAuthStatus(await this.getJson('/v1/auth/status', signal));
  }

  async createDeviceAuthorization(
    clientId = 'echolens-cli',
    scope = ['models:read', 'inference:create', 'usage:read', 'account:read'],
    signal?: AbortSignal,
  ): Promise<GatewayDeviceAuthorization> {
    const { payload } = await this.postForm('/oauth/device/authorization', {
      client_id: clientId,
      scope: scope.join(' '),
    }, signal);
    if (!isRecord(payload) || typeof payload.device_code !== 'string'
      || typeof payload.user_code !== 'string' || typeof payload.verification_uri !== 'string'
      || typeof payload.expires_in !== 'number' || typeof payload.interval !== 'number') {
      throw invalidGatewayResponse('Gateway Device Authorization 响应无效');
    }
    return {
      deviceCode: payload.device_code,
      userCode: payload.user_code,
      verificationUri: payload.verification_uri,
      verificationUriComplete: typeof payload.verification_uri_complete === 'string'
        ? payload.verification_uri_complete : undefined,
      expiresIn: payload.expires_in,
      interval: payload.interval,
    };
  }

  async pollDeviceToken(
    deviceCode: string,
    clientId = 'echolens-cli',
    signal?: AbortSignal,
  ): Promise<GatewayTokenSet | { pending: true; interval: number }> {
    const { response, payload } = await this.postForm('/oauth/token', {
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      device_code: deviceCode,
      client_id: clientId,
    }, signal);
    if (!response.ok) {
      const code = isRecord(payload) && typeof payload.error === 'string' ? payload.error : 'unknown_gateway_error';
      if (code === 'authorization_pending' || code === 'slow_down') {
        return { pending: true, interval: numberField(payload, 'interval') ?? 5 };
      }
      throw new GatewayClientError({
        code: code === 'expired_token' ? 'token_expired' : 'authentication_required',
        message: 'Gateway Device Flow 未完成',
        retryable: false,
        status: response.status,
      });
    }
    return decodeTokenSet(payload);
  }

  async refreshToken(refreshToken: string, clientId = 'echolens-cli', signal?: AbortSignal): Promise<GatewayTokenSet> {
    const { response, payload } = await this.postForm('/oauth/token', {
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: clientId,
    }, signal);
    if (!response.ok) throw gatewayHttpError(response, payload);
    return decodeTokenSet(payload);
  }

  async revokeToken(token: string, signal?: AbortSignal): Promise<void> {
    const { response, payload } = await this.postForm('/oauth/revoke', { token }, signal);
    if (!response.ok) throw gatewayHttpError(response, payload);
  }

  async account(signal?: AbortSignal): Promise<GatewayAccount> {
    const payload = await this.getJson('/v1/me', signal);
    if (!isRecord(payload) || typeof payload.id !== 'string') throw invalidGatewayResponse('Gateway 账户响应无效');
    return { id: payload.id, displayName: typeof payload.display_name === 'string' ? payload.display_name : undefined };
  }

  async listModels(signal?: AbortSignal): Promise<GatewayModelList> {
    const payload = await this.getJson('/v1/models', signal);
    if (!isRecord(payload) || !Array.isArray(payload.data)) {
      throw new GatewayClientError({
        code: 'invalid_gateway_response',
        message: 'Gateway 模型目录响应无效',
        retryable: false,
      });
    }
    return { models: payload.data.map(decodeModelDescriptor) };
  }

  private async getJson(path: string, externalSignal?: AbortSignal): Promise<unknown> {
    const attempt = createRequestSignal(
      externalSignal,
      this.requestTimeoutMs,
      'Gateway request timed out',
    );
    try {
      let response: Response;
      try {
        response = await this.fetchImplementation(`${this.gatewayUrl}${path}`, {
          method: 'GET',
          headers: { authorization: `Bearer ${this.options.accessToken}` },
          signal: attempt.signal,
        });
      } catch (error) {
        if (externalSignal?.aborted) {
          throw new GatewayClientError({
            code: 'request_cancelled',
            message: 'Gateway 请求已取消',
            retryable: false,
            cause: error,
          });
        }
        throw new GatewayClientError({
          code: 'gateway_unreachable',
          message: attempt.timedOut() ? 'Gateway 请求超时' : '无法连接 Gateway',
          retryable: true,
          cause: error,
        });
      }

      const headerRequestId = response.headers.get('x-request-id') ?? undefined;
      let payload: unknown;
      try {
        payload = await response.json();
      } catch (error) {
        throw new GatewayClientError({
          code: 'invalid_gateway_response',
          message: 'Gateway 返回了无法解析的响应',
          retryable: false,
          status: response.status,
          requestId: headerRequestId,
          cause: error,
        });
      }

      const requestId = headerRequestId ?? stringField(payload, 'request_id');
      if (!response.ok) throw gatewayHttpError(response, payload, requestId);
      return payload;
    } finally {
      attempt.dispose();
    }
  }

  private async postForm(
    path: string,
    values: Record<string, string>,
    externalSignal?: AbortSignal,
  ): Promise<{ response: Response; payload: unknown }> {
    const attempt = createRequestSignal(externalSignal, this.requestTimeoutMs, 'Gateway request timed out');
    try {
      let response: Response;
      try {
        response = await this.fetchImplementation(`${this.gatewayUrl}${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams(values).toString(),
          signal: attempt.signal,
        });
      } catch (error) {
        const cancelled = externalSignal?.aborted ?? false;
        throw new GatewayClientError({
          code: cancelled ? 'request_cancelled' : 'gateway_unreachable',
          message: cancelled
            ? 'Gateway 请求已取消'
            : attempt.timedOut() ? 'Gateway 请求超时' : '无法连接 Gateway',
          retryable: !cancelled,
          cause: error,
        });
      }
      const text = await response.text();
      if (!text) return { response, payload: undefined };
      try {
        return { response, payload: JSON.parse(text) as unknown };
      } catch (error) {
        throw new GatewayClientError({
          code: 'invalid_gateway_response',
          message: 'Gateway 表单响应无法解析',
          retryable: false,
          status: response.status,
          requestId: response.headers.get('x-request-id') ?? undefined,
          cause: error,
        });
      }
    } finally {
      attempt.dispose();
    }
  }
}

function gatewayHttpError(response: Response, payload: unknown, requestId?: string): GatewayClientError {
  const details = safeProviderDetails(payload);
  const code = isGatewayErrorCode(details.code) ? details.code : defaultGatewayCode(response.status);
  return new GatewayClientError({
    code,
    message: gatewayErrorMessage(code, response.status),
    retryable: booleanField(isRecord(payload) ? payload.error : undefined, 'retryable')
      ?? (response.status === 429 || response.status >= 500),
    status: response.status,
    requestId: requestId ?? response.headers.get('x-request-id') ?? undefined,
    retryAfterMs: parseRetryAfter(response.headers.get('retry-after')),
  });
}

function decodeAuthStatus(payload: unknown): GatewayAuthStatus {
  if (!isRecord(payload) || !isGatewayAuthState(payload.status)) {
    throw invalidGatewayResponse('Gateway 登录状态响应无效');
  }
  const account = isRecord(payload.account) && typeof payload.account.id === 'string'
    ? {
        id: payload.account.id,
        displayName: typeof payload.account.display_name === 'string'
          ? payload.account.display_name
          : undefined,
      }
    : undefined;
  return {
    status: payload.status,
    account,
    expiresAt: typeof payload.expires_at === 'string' ? payload.expires_at : undefined,
  };
}

function decodeModelDescriptor(payload: unknown): GatewayModelDescriptor {
  if (!isRecord(payload) || typeof payload.id !== 'string') {
    throw invalidGatewayResponse('Gateway 模型条目缺少 ID');
  }
  if (!Array.isArray(payload.protocols)
    || payload.protocols.length === 0
    || payload.protocols.some((protocol) => !isProtocol(protocol))) {
    throw invalidGatewayResponse(`Gateway 模型 ${payload.id} 的协议列表无效`);
  }
  const protocols = payload.protocols as OpenAICompatibleProtocol[];
  if (!isProtocol(payload.default_protocol) || !protocols.includes(payload.default_protocol)) {
    throw invalidGatewayResponse(`Gateway 模型 ${payload.id} 的协议声明无效`);
  }
  return {
    id: payload.id,
    protocols,
    defaultProtocol: payload.default_protocol,
    capabilities: decodeCapabilities(payload.capabilities, payload.id),
  };
}

function decodeCapabilities(payload: unknown, model: string): ProviderCapabilities {
  if (!isRecord(payload)) throw invalidGatewayResponse(`Gateway 模型 ${model} 缺少能力声明`);
  const maxContextTokens = payload.max_context_tokens;
  const fields = [
    'supports_streaming',
    'supports_tool_calls',
    'supports_parallel_tool_calls',
    'supports_structured_output',
    'supports_prompt_caching',
    'supports_usage_reporting',
  ] as const;
  if (typeof maxContextTokens !== 'number' || !Number.isInteger(maxContextTokens) || maxContextTokens <= 0
    || fields.some((field) => typeof payload[field] !== 'boolean')) {
    throw invalidGatewayResponse(`Gateway 模型 ${model} 的能力声明无效`);
  }
  return {
    maxContextTokens,
    supportsStreaming: payload.supports_streaming as boolean,
    supportsToolCalls: payload.supports_tool_calls as boolean,
    supportsParallelToolCalls: payload.supports_parallel_tool_calls as boolean,
    supportsStructuredOutput: payload.supports_structured_output as boolean,
    supportsPromptCaching: payload.supports_prompt_caching as boolean,
    supportsUsageReporting: payload.supports_usage_reporting as boolean,
  };
}

function invalidGatewayResponse(message: string): GatewayClientError {
  return new GatewayClientError({
    code: 'invalid_gateway_response',
    message,
    retryable: false,
  });
}

function defaultGatewayCode(status: number): GatewayErrorCode {
  if (status === 401) return 'invalid_token';
  if (status === 403) return 'insufficient_scope';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'upstream_unavailable';
  return 'unknown_gateway_error';
}

function gatewayErrorMessage(code: GatewayErrorCode, status: number): string {
  const messages: Partial<Record<GatewayErrorCode, string>> = {
    invalid_request: 'Gateway 请求参数无效',
    authentication_required: 'Gateway 需要登录',
    invalid_token: 'Gateway Access Token 无效',
    token_expired: 'Gateway Access Token 已过期',
    insufficient_scope: 'Gateway Token 权限不足',
    model_not_allowed: '当前账号不能使用所选模型',
    quota_exceeded: 'Gateway 账户额度已用尽',
    rate_limited: 'Gateway 请求受到限流',
    upstream_unavailable: 'Gateway 上游模型不可用',
    upstream_timeout: 'Gateway 上游模型请求超时',
    upstream_response_too_large: 'Gateway 上游响应超过大小限制',
    request_too_large: '发送给 Gateway 的请求过大',
    content_blocked: 'Gateway 内容策略阻止了请求',
  };
  return `${messages[code] ?? 'Gateway 请求失败'}：HTTP ${status}`;
}

function isGatewayErrorCode(value: string | undefined): value is GatewayErrorCode {
  return value !== undefined && [
    'authentication_required',
    'invalid_request',
    'invalid_token',
    'token_expired',
    'insufficient_scope',
    'model_not_allowed',
    'quota_exceeded',
    'rate_limited',
    'upstream_unavailable',
    'upstream_timeout',
    'upstream_response_too_large',
    'request_too_large',
    'content_blocked',
  ].includes(value);
}

function isGatewayAuthState(value: unknown): value is GatewayAuthState {
  return typeof value === 'string' && [
    'not_configured',
    'signed_out',
    'device_authorization_pending',
    'signed_in',
    'token_expired',
    'revoked',
    'gateway_unreachable',
    'entitlement_denied',
  ].includes(value);
}

function isProtocol(value: unknown): value is OpenAICompatibleProtocol {
  return value === 'chat_completions' || value === 'responses';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringField(value: unknown, field: string): string | undefined {
  return isRecord(value) && typeof value[field] === 'string' ? value[field] as string : undefined;
}

function booleanField(value: unknown, field: string): boolean | undefined {
  return isRecord(value) && typeof value[field] === 'boolean' ? value[field] as boolean : undefined;
}

async function parseJsonResponse(response: Response, label: string): Promise<unknown> {
  try {
    return await response.json();
  } catch (error) {
    throw new GatewayClientError({
      code: 'invalid_gateway_response',
      message: `${label} 无法解析`,
      retryable: false,
      status: response.status,
      cause: error,
    });
  }
}

function decodeTokenSet(payload: unknown): GatewayTokenSet {
  if (!isRecord(payload) || typeof payload.access_token !== 'string'
    || typeof payload.token_type !== 'string' || typeof payload.expires_in !== 'number') {
    throw invalidGatewayResponse('Gateway Token 响应无效');
  }
  return {
    accessToken: payload.access_token,
    refreshToken: typeof payload.refresh_token === 'string' ? payload.refresh_token : undefined,
    tokenType: payload.token_type,
    expiresIn: payload.expires_in,
    scope: typeof payload.scope === 'string' ? payload.scope.split(/\s+/u).filter(Boolean) : [],
  };
}

function numberField(value: unknown, field: string): number | undefined {
  return isRecord(value) && typeof value[field] === 'number' ? value[field] as number : undefined;
}
