import {
  EnvironmentCredentialResolver,
  type CredentialResolver,
} from '../credentials/index.js';
import {
  GatewayClient,
  GatewayClientError,
  type GatewayAuthState,
} from '../providers/gateway/index.js';
import {
  OpenAICompatibleProvider,
  type OpenAICompatibleProtocol,
} from '../providers/openai-compatible/index.js';
import { redactUrl } from '../providers/redaction.js';
import type { ModelProvider, ProviderCapabilities } from '../providers/types.js';

export type ModelRoute = 'gateway' | 'direct';
export type PrivacyLevel = 'metadata' | 'evidence' | 'full-context';

export interface DirectRouteConfig {
  route: 'direct';
  providerUrl: string;
  model: string;
  protocol: OpenAICompatibleProtocol;
  credentialRef: string;
  privacy: PrivacyLevel;
}

export interface GatewayRouteConfig {
  route: 'gateway';
  gatewayUrl: string;
  model: string;
  credentialRef: string;
  privacy: PrivacyLevel;
}

export type ModelRouteConfig = DirectRouteConfig | GatewayRouteConfig;

export type RouteState =
  | 'ready'
  | 'configured'
  | 'not_configured'
  | 'invalid_config'
  | 'legacy_route_removed'
  | 'credential_missing'
  | 'credential_reference_unsupported'
  | 'privacy_mode_unavailable'
  | 'cancelled'
  | GatewayAuthState
  | 'upstream_unavailable'
  | 'model_not_allowed';

export interface RouteStatus {
  route?: ModelRoute;
  requestedRoute?: string;
  state: RouteState;
  available: boolean;
  reasonCode: string;
  reason: string;
  model?: string;
  baseUrl?: string;
  protocol?: OpenAICompatibleProtocol;
  privacy?: PrivacyLevel;
  capabilities?: ProviderCapabilities;
}

export interface ModelRouteConnection {
  status: RouteStatus;
  provider: ModelProvider | null;
}

export interface ModelRouterOptions {
  credentialResolver?: CredentialResolver;
  fetch?: typeof globalThis.fetch;
  directCapabilities?: Partial<ProviderCapabilities>;
  requestTimeoutMs?: number;
}

type ParsedConfig =
  | { config: ModelRouteConfig; issue?: never }
  | { config?: never; issue: RouteStatus };

export class ModelRouter {
  private constructor(
    private readonly parsed: ParsedConfig,
    private readonly credentialResolver: CredentialResolver,
    private readonly options: ModelRouterOptions,
  ) {}

  static fromEnv(env: NodeJS.ProcessEnv = process.env, options: ModelRouterOptions = {}): ModelRouter {
    return new ModelRouter(
      parseModelRouteConfig(env),
      options.credentialResolver ?? new EnvironmentCredentialResolver(env),
      options,
    );
  }

  static fromConfig(
    config: ModelRouteConfig,
    options: ModelRouterOptions & { credentialResolver: CredentialResolver },
  ): ModelRouter {
    return new ModelRouter({ config }, options.credentialResolver, options);
  }

  inspect(): RouteStatus {
    if (this.parsed.issue) return this.parsed.issue;
    const privacyStatus = unsupportedPrivacyStatus(this.parsed.config);
    if (privacyStatus) return privacyStatus;
    return statusFor(
      this.parsed.config,
      'configured',
      false,
      'route_not_connected',
      '模型路由尚未连接',
    );
  }

  async status(signal?: AbortSignal): Promise<RouteStatus> {
    return (await this.connect(signal)).status;
  }

  async build(signal?: AbortSignal): Promise<ModelProvider | null> {
    return (await this.connect(signal)).provider;
  }

  async connect(signal?: AbortSignal): Promise<ModelRouteConnection> {
    if (this.parsed.issue) return { status: this.parsed.issue, provider: null };
    const config = this.parsed.config;
    const privacyStatus = unsupportedPrivacyStatus(config);
    if (privacyStatus) return { status: privacyStatus, provider: null };
    const credential = await this.credentialResolver.resolve(config.credentialRef, {
      purpose: config.route === 'direct' ? 'direct_provider' : 'gateway_access',
      audience: config.route === 'direct' ? config.providerUrl : config.gatewayUrl,
    });

    if (credential.status === 'unsupported_reference') {
      return unavailable(
        config,
        'credential_reference_unsupported',
        'credential_reference_unsupported',
        `当前客户端不支持凭据引用：${config.credentialRef.split(':', 1)[0] ?? 'unknown'}`,
      );
    }
    if (credential.status === 'missing') {
      const state = config.route === 'gateway' ? 'signed_out' : 'credential_missing';
      return unavailable(
        config,
        state,
        state,
        config.route === 'gateway' ? 'Gateway 尚未登录' : 'Direct API 凭据不存在',
      );
    }

    if (config.route === 'direct') {
      const provider = new OpenAICompatibleProvider({
        model: config.model,
        baseUrl: config.providerUrl,
        apiKey: credential.value,
        protocol: config.protocol,
        capabilities: this.options.directCapabilities,
        fetch: this.options.fetch,
        requestTimeoutMs: this.options.requestTimeoutMs,
      });
      return {
        provider,
        status: statusFor(
          config,
          'ready',
          true,
          'ready',
          'Direct 模型路由已就绪',
          provider.capabilities,
        ),
      };
    }

    return this.connectGateway(config, credential.value, signal);
  }

  private async connectGateway(
    config: GatewayRouteConfig,
    accessToken: string,
    signal?: AbortSignal,
  ): Promise<ModelRouteConnection> {
    const client = new GatewayClient({
      gatewayUrl: config.gatewayUrl,
      accessToken,
      fetch: this.options.fetch,
      requestTimeoutMs: this.options.requestTimeoutMs,
    });

    try {
      const auth = await client.authStatus(signal);
      if (auth.status !== 'signed_in') {
        return unavailable(config, auth.status, auth.status, authReason(auth.status));
      }

      const catalog = await client.listModels(signal);
      const descriptor = catalog.models.find((model) => model.id === config.model);
      if (!descriptor) {
        return unavailable(
          config,
          'model_not_allowed',
          'model_not_allowed',
          'Gateway 未向当前账号提供所选模型',
        );
      }

      const provider = new OpenAICompatibleProvider({
        model: descriptor.id,
        baseUrl: `${config.gatewayUrl}/v1`,
        apiKey: accessToken,
        protocol: descriptor.defaultProtocol,
        capabilities: descriptor.capabilities,
        fetch: this.options.fetch,
        requestTimeoutMs: this.options.requestTimeoutMs,
      });
      return {
        provider,
        status: statusFor(
          config,
          'ready',
          true,
          'ready',
          'Gateway 模型路由已就绪',
          provider.capabilities,
          descriptor.defaultProtocol,
        ),
      };
    } catch (error) {
      if (!(error instanceof GatewayClientError)) throw error;
      const state = gatewayState(error);
      return unavailable(config, state, error.code, error.message);
    }
  }
}

export function parseModelRouteConfig(env: NodeJS.ProcessEnv): ParsedConfig {
  const requestedRoute = env.AGENT_MODEL_ROUTE?.trim();
  if (!requestedRoute) {
    return issue('not_configured', 'route_not_configured', '必须显式配置 AGENT_MODEL_ROUTE');
  }
  if (requestedRoute === 'local') {
    return issue(
      'legacy_route_removed',
      'legacy_route_local_removed',
      'local 路由已删除；如需调用自建兼容 API，请显式配置 direct 路由',
      requestedRoute,
    );
  }
  if (requestedRoute === 'cloud') {
    return issue(
      'legacy_route_removed',
      'legacy_route_cloud_removed',
      'cloud 路由已删除；请迁移到 gateway 路由',
      requestedRoute,
    );
  }
  if (requestedRoute !== 'direct' && requestedRoute !== 'gateway') {
    return issue('invalid_config', 'invalid_route', `未知模型路由：${requestedRoute}`, requestedRoute);
  }

  const prefix = requestedRoute.toUpperCase();
  const privacy = privacyValue(env[`AGENT_${prefix}_PRIVACY`]);
  if (!privacy) {
    return issue(
      'invalid_config',
      'privacy_not_configured',
      `路由 ${requestedRoute} 必须显式配置隐私等级`,
      requestedRoute,
    );
  }

  if (requestedRoute === 'direct') {
    const model = required(env.AGENT_DIRECT_MODEL);
    const providerUrl = serviceUrl(env.AGENT_DIRECT_BASE_URL);
    const credentialRef = required(env.AGENT_DIRECT_CREDENTIAL_REF);
    const protocol = protocolValue(env.AGENT_DIRECT_PROTOCOL);
    if (!model || !providerUrl || !credentialRef || !protocol) {
      return issue(
        'invalid_config',
        'direct_config_invalid',
        'Direct 路由需要合法的 Base URL、Model、Protocol、Credential Reference 和 Privacy',
        requestedRoute,
      );
    }
    return {
      config: { route: 'direct', providerUrl, model, protocol, credentialRef, privacy },
    };
  }

  const model = required(env.AGENT_GATEWAY_MODEL);
  const gatewayUrl = serviceUrl(env.AGENT_GATEWAY_URL);
  const credentialRef = required(env.AGENT_GATEWAY_CREDENTIAL_REF);
  if (!model || !gatewayUrl || !credentialRef) {
    return issue(
      'invalid_config',
      'gateway_config_invalid',
      'Gateway 路由需要合法的 URL、Model、Credential Reference 和 Privacy',
      requestedRoute,
    );
  }
  return { config: { route: 'gateway', gatewayUrl, model, credentialRef, privacy } };
}

function statusFor(
  config: ModelRouteConfig,
  state: RouteState,
  available: boolean,
  reasonCode: string,
  reason: string,
  capabilities?: ProviderCapabilities,
  gatewayProtocol?: OpenAICompatibleProtocol,
): RouteStatus {
  return {
    route: config.route,
    requestedRoute: config.route,
    state,
    available,
    reasonCode,
    reason,
    model: config.model,
    baseUrl: redactUrl(config.route === 'direct' ? config.providerUrl : config.gatewayUrl),
    protocol: config.route === 'direct' ? config.protocol : gatewayProtocol,
    privacy: config.privacy,
    capabilities,
  };
}

function unavailable(
  config: ModelRouteConfig,
  state: RouteState,
  reasonCode: string,
  reason: string,
): ModelRouteConnection {
  return { provider: null, status: statusFor(config, state, false, reasonCode, reason) };
}

function unsupportedPrivacyStatus(config: ModelRouteConfig): RouteStatus | undefined {
  return config.privacy === 'full-context'
    ? undefined
    : statusFor(
        config,
        'privacy_mode_unavailable',
        false,
        'privacy_mode_unavailable',
        'v0.2 尚未实现上下文裁剪；metadata/evidence 模式拒绝发送模型请求',
      );
}

function issue(
  state: RouteState,
  reasonCode: string,
  reason: string,
  requestedRoute?: string,
): ParsedConfig {
  return {
    issue: {
      requestedRoute,
      state,
      available: false,
      reasonCode,
      reason,
    },
  };
}

function required(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized || undefined;
}

function privacyValue(value: string | undefined): PrivacyLevel | undefined {
  return value === 'metadata' || value === 'evidence' || value === 'full-context'
    ? value
    : undefined;
}

function protocolValue(value: string | undefined): OpenAICompatibleProtocol | undefined {
  return value === 'chat_completions' || value === 'responses' ? value : undefined;
}

function serviceUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
    if (url.username || url.password || url.search || url.hash) return undefined;
    if (url.protocol !== 'https:' && !isLoopback(url.hostname)) return undefined;
    return url.toString().replace(/\/$/, '');
  } catch {
    return undefined;
  }
}

function isLoopback(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

function authReason(state: GatewayAuthState): string {
  const reasons: Record<GatewayAuthState, string> = {
    not_configured: 'Gateway 登录尚未配置',
    signed_out: 'Gateway 尚未登录',
    device_authorization_pending: 'Gateway 登录正在等待用户确认',
    signed_in: 'Gateway 已登录',
    token_expired: 'Gateway Access Token 已过期',
    revoked: 'Gateway 登录凭据已撤销',
    gateway_unreachable: 'Gateway 当前不可达',
    entitlement_denied: '当前账号没有 Gateway 使用权限',
  };
  return reasons[state];
}

function gatewayState(error: GatewayClientError): RouteState {
  if (error.code === 'authentication_required' || error.code === 'invalid_token') return 'signed_out';
  if (error.code === 'token_expired') return 'token_expired';
  if (error.code === 'insufficient_scope') return 'entitlement_denied';
  if (error.code === 'model_not_allowed') return 'model_not_allowed';
  if (error.code === 'request_cancelled') return 'cancelled';
  if (error.code === 'gateway_unreachable') return 'gateway_unreachable';
  return 'upstream_unavailable';
}
