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

  // 安全边界：错误消息、cause 与 requestId 可能携带 Gateway 回显的令牌或用户数据，
  // 在写入实例前统一脱敏，确保 Error 被记入日志时凭据不会外泄。
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

/**
 * Gateway 协议客户端：设备授权、令牌轮换、账户与模型查询。
 *
 * 凭据只存在于 Authorization 头，从不写入日志；所有响应按不可信输入严格校验结构
 * （decode* 系列），失败统一抛 `GatewayClientError` 并携带稳定错误码。
 */
export class GatewayClient {
  private readonly gatewayUrl: string;
  private readonly fetchImplementation: typeof globalThis.fetch;
  private readonly requestTimeoutMs: number;

  constructor(private readonly options: GatewayClientOptions) {
    // 去掉末尾斜杠，避免与以 / 开头的 path 拼接时出现双斜杠破坏路由。
    this.gatewayUrl = options.gatewayUrl.replace(/\/$/, '');
    this.fetchImplementation = options.fetch ?? globalThis.fetch;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
  }

  async authStatus(signal?: AbortSignal): Promise<GatewayAuthStatus> {
    return decodeAuthStatus(await this.getJson('/v1/auth/status', signal));
  }

  // 默认 scope 只申请当前功能所需的最小权限集；调用方需要更多权限时必须显式传入。
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
      // RFC 8628 Device Authorization：authorization_pending 表示用户尚未完成授权，
      // slow_down 表示轮询过快需放慢——两者都不是错误，沿用服务端建议的 interval（缺省 5 秒）。
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
    const { response, payload } = await this.request(path, {
      method: 'GET',
      headers: { authorization: `Bearer ${this.options.accessToken}` },
    }, externalSignal);
    if (!response.ok) throw gatewayHttpError(response, payload, requestId(response, payload));
    if (payload === undefined) throw invalidGatewayResponse('Gateway 返回了空响应', response.status);
    return payload;
  }

  private async postForm(
    path: string,
    values: Record<string, string>,
    externalSignal?: AbortSignal,
  ): Promise<{ response: Response; payload: unknown }> {
    return this.request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(values).toString(),
    }, externalSignal);
  }

  private async request(
    path: string,
    init: RequestInit,
    externalSignal?: AbortSignal,
  ): Promise<{ response: Response; payload: unknown }> {
    const attempt = createRequestSignal(externalSignal, this.requestTimeoutMs, 'Gateway request timed out');
    try {
      let response: Response;
      try {
        response = await this.fetchImplementation(`${this.gatewayUrl}${path}`, {
          ...init,
          signal: attempt.signal,
        });
      } catch (error) {
        // 内部超时只 abort 本请求的 controller，不会置位外部 signal，
        // 因此用 externalSignal.aborted 区分“用户取消”与“超时/断连”。
        // 取消不可重试（用户已主动中止），超时与断连可重试。
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
          message: 'Gateway 返回了无法解析的响应',
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

// Gateway 可在错误体里显式声明 retryable（布尔字段），优先采用；
// 缺省时仅 429（限流）与 5xx（上游故障）判定为可重试，其余 4xx 不重试。
// 同时把 Retry-After 头换算为毫秒交给调用方退避。
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

function invalidGatewayResponse(message: string, status?: number): GatewayClientError {
  return new GatewayClientError({
    code: 'invalid_gateway_response',
    message,
    retryable: false,
    status,
  });
}

function requestId(response: Response, payload: unknown): string | undefined {
  return response.headers.get('x-request-id') ?? stringField(payload, 'request_id');
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
