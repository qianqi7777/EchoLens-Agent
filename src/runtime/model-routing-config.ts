import {
  CompositeCredentialResolver,
  EnvironmentCredentialResolver,
  GatewayTokenCredentialResolver,
} from '../credentials/index.js';
import type { ModelProvider, ProviderCapabilities } from '../providers/types.js';
import {
  ModelRouter,
  parseModelRouteConfig,
  type ModelRouteConfig,
  type PrivacyLevel,
  type RouteStatus,
} from './model-router.js';
import {
  RoutedModelProvider,
  type ModelProfile,
  type ModelRoutingMode,
  type RoutedModelProviderOptions,
  type TaskTier,
} from './model-routing.js';

interface SerializedModelProfile {
  id: string;
  tier: TaskTier;
  route: 'direct' | 'gateway';
  model: string;
  privacy: PrivacyLevel;
  credentialRef: string;
  providerUrl?: string;
  gatewayUrl?: string;
  protocol?: 'chat_completions' | 'responses';
  streaming?: boolean;
  capabilities?: Partial<ProviderCapabilities>;
  estimatedInputCostPer1k?: number;
  estimatedOutputCostPer1k?: number;
  latencyHintMs?: number;
}

export interface RoutedModelConnection {
  provider: RoutedModelProvider;
  profiles: readonly ModelProfile[];
  notices: string[];
}

/**
 * 从本地环境构建路由 Provider。主路由始终是 default Profile；额外 Profile 使用相同
 * Credential Resolver 规则独立连接，因此凭据不会被模型池配置直接内联或共享到日志。
 */
export async function connectRoutedModelProviderFromEnv(
  primary: ModelProvider,
  primaryStatus: RouteStatus,
  env: NodeJS.ProcessEnv = process.env,
): Promise<RoutedModelConnection> {
  const mode = routingMode(env.AGENT_ROUTING_MODE);
  const primaryProfile: ModelProfile = {
    id: 'default',
    provider: primary,
    tier: tierValue(env.AGENT_ROUTING_DEFAULT_TIER, 'AGENT_ROUTING_DEFAULT_TIER') ?? 2,
    privacy: primaryStatus.privacy ?? 'full-context',
    estimatedInputCostPer1k: decimal(env.AGENT_ROUTING_DEFAULT_INPUT_COST_PER_1K, 'AGENT_ROUTING_DEFAULT_INPUT_COST_PER_1K'),
    estimatedOutputCostPer1k: decimal(env.AGENT_ROUTING_DEFAULT_OUTPUT_COST_PER_1K, 'AGENT_ROUTING_DEFAULT_OUTPUT_COST_PER_1K'),
    latencyHintMs: positiveInteger(env.AGENT_ROUTING_DEFAULT_LATENCY_MS, 'AGENT_ROUTING_DEFAULT_LATENCY_MS'),
  };
  const profiles: ModelProfile[] = [primaryProfile];
  const notices: string[] = [];
  // 预加载池使 /model 可以在同一 Session 从 off 切换到路由模式；off 仅禁用选择与
  // fallback，仍保持单模型执行。已声明的池配置必须校验，避免错误在切换后才暴露。
  for (const raw of parseProfiles(env.AGENT_MODEL_PROFILES)) {
    if (raw.id === 'default') throw new Error('AGENT_MODEL_PROFILES 不可使用保留 ID default');
    const config = routeConfig(raw);
    const router = ModelRouter.fromConfig(config, {
      credentialResolver: new CompositeCredentialResolver([
        new EnvironmentCredentialResolver(env),
        new GatewayTokenCredentialResolver(undefined),
      ]),
      directCapabilities: raw.capabilities,
    });
    const connection = await router.connect();
    if (!connection.provider) {
      notices.push(`模型 ${raw.id} 未加入候选池 [${connection.status.reasonCode}]`);
      continue;
    }
    profiles.push({
      id: raw.id,
      provider: connection.provider,
      tier: raw.tier,
      privacy: raw.privacy,
      estimatedInputCostPer1k: raw.estimatedInputCostPer1k,
      estimatedOutputCostPer1k: raw.estimatedOutputCostPer1k,
      latencyHintMs: raw.latencyHintMs,
    });
  }
  const routingOptions: RoutedModelProviderOptions = {
    mode,
    defaultProfileId: 'default',
    allowTierDowngrade: boolean(env.AGENT_ROUTING_ALLOW_TIER_DOWNGRADE, true, 'AGENT_ROUTING_ALLOW_TIER_DOWNGRADE'),
    maxFallbacks: nonNegativeInteger(env.AGENT_ROUTING_MAX_FALLBACKS, 'AGENT_ROUTING_MAX_FALLBACKS') ?? 1,
  };
  return { provider: new RoutedModelProvider(profiles, routingOptions), profiles, notices };
}

export function routingMode(value: string | undefined): ModelRoutingMode {
  const normalized = value?.trim() || 'off';
  if (['off', 'auto', 'fast', 'balanced', 'quality', 'privacy'].includes(normalized)) {
    return normalized as ModelRoutingMode;
  }
  if (normalized.startsWith('pinned:') && /^[a-zA-Z0-9._-]+$/u.test(normalized.slice(7))) {
    return normalized as ModelRoutingMode;
  }
  throw new Error('AGENT_ROUTING_MODE 必须为 off、auto、fast、balanced、quality、privacy 或 pinned:<profileId>');
}

function parseProfiles(value: string | undefined): SerializedModelProfile[] {
  if (!value?.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error('AGENT_MODEL_PROFILES 必须是合法 JSON 数组');
  }
  if (!Array.isArray(parsed)) throw new Error('AGENT_MODEL_PROFILES 必须是 JSON 数组');
  const ids = new Set<string>();
  return parsed.map((item, index) => {
    const profile = parseProfile(item, index);
    if (ids.has(profile.id)) throw new Error(`AGENT_MODEL_PROFILES 的模型 ID 重复：${profile.id}`);
    ids.add(profile.id);
    return profile;
  });
}

function parseProfile(value: unknown, index: number): SerializedModelProfile {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`模型 Profile #${index + 1} 必须是对象`);
  const input = value as Record<string, unknown>;
  const id = string(input.id);
  const route = input.route;
  const tier = input.tier;
  const privacy = input.privacy;
  if (!id || !/^[a-zA-Z0-9._-]+$/u.test(id)) throw new Error(`模型 Profile #${index + 1} 的 id 非法`);
  if (route !== 'direct' && route !== 'gateway') throw new Error(`模型 Profile ${id} 的 route 非法`);
  if (!Number.isInteger(tier) || Number(tier) < 0 || Number(tier) > 3) throw new Error(`模型 Profile ${id} 的 tier 必须是 0 到 3 的整数`);
  if (privacy !== 'metadata' && privacy !== 'evidence' && privacy !== 'full-context') throw new Error(`模型 Profile ${id} 的 privacy 非法`);
  const base: SerializedModelProfile = {
    id,
    tier: tier as TaskTier,
    route,
    model: requiredString(input.model, id, 'model'),
    privacy,
    credentialRef: requiredString(input.credentialRef, id, 'credentialRef'),
    estimatedInputCostPer1k: finite(input.estimatedInputCostPer1k, id, 'estimatedInputCostPer1k'),
    estimatedOutputCostPer1k: finite(input.estimatedOutputCostPer1k, id, 'estimatedOutputCostPer1k'),
    latencyHintMs: finite(input.latencyHintMs, id, 'latencyHintMs'),
    capabilities: capabilities(input.capabilities, id),
  };
  if (route === 'direct') {
    return {
      ...base,
      providerUrl: requiredString(input.providerUrl, id, 'providerUrl'),
      protocol: protocol(input.protocol, id),
      streaming: optionalBoolean(input.streaming, id, 'streaming'),
    };
  }
  return { ...base, gatewayUrl: requiredString(input.gatewayUrl, id, 'gatewayUrl') };
}

function routeConfig(profile: SerializedModelProfile): ModelRouteConfig {
  const env: NodeJS.ProcessEnv = profile.route === 'direct'
    ? {
      AGENT_MODEL_ROUTE: 'direct', AGENT_DIRECT_MODEL: profile.model,
      AGENT_DIRECT_BASE_URL: profile.providerUrl, AGENT_DIRECT_PROTOCOL: profile.protocol,
      AGENT_DIRECT_CREDENTIAL_REF: profile.credentialRef, AGENT_DIRECT_PRIVACY: profile.privacy,
      AGENT_DIRECT_STREAMING: String(profile.streaming ?? true),
    }
    : {
      AGENT_MODEL_ROUTE: 'gateway', AGENT_GATEWAY_MODEL: profile.model,
      AGENT_GATEWAY_URL: profile.gatewayUrl, AGENT_GATEWAY_CREDENTIAL_REF: profile.credentialRef,
      AGENT_GATEWAY_PRIVACY: profile.privacy, AGENT_GATEWAY_PRIVACY_CONFIRMED: 'true',
    };
  const parsed = parseModelRouteConfig(env);
  if (!parsed.config) throw new Error(`模型 Profile ${profile.id} 配置无效 [${parsed.issue.reasonCode}]`);
  return parsed.config;
}

function capabilities(value: unknown, id: string): Partial<ProviderCapabilities> | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`模型 Profile ${id} 的 capabilities 必须是对象`);
  const input = value as Record<string, unknown>;
  const result: Partial<ProviderCapabilities> = {};
  for (const key of ['supportsStreaming', 'supportsToolCalls', 'supportsParallelToolCalls', 'supportsStructuredOutput', 'supportsPromptCaching', 'supportsUsageReporting'] as const) {
    if (input[key] !== undefined) {
      if (typeof input[key] !== 'boolean') throw new Error(`模型 Profile ${id} 的 capabilities.${key} 必须是布尔值`);
      result[key] = input[key] as boolean;
    }
  }
  if (input.maxContextTokens !== undefined) {
    if (!Number.isSafeInteger(input.maxContextTokens) || Number(input.maxContextTokens) < 512) throw new Error(`模型 Profile ${id} 的 capabilities.maxContextTokens 非法`);
    result.maxContextTokens = Number(input.maxContextTokens);
  }
  return result;
}

function string(value: unknown): string | undefined { return typeof value === 'string' && value.trim() ? value.trim() : undefined; }
function requiredString(value: unknown, id: string, key: string): string { const result = string(value); if (!result) throw new Error(`模型 Profile ${id} 缺少 ${key}`); return result; }
function protocol(value: unknown, id: string): 'chat_completions' | 'responses' { if (value === 'chat_completions' || value === 'responses') return value; throw new Error(`模型 Profile ${id} 的 protocol 非法`); }
function optionalBoolean(value: unknown, id: string, key: string): boolean | undefined { if (value === undefined) return undefined; if (typeof value !== 'boolean') throw new Error(`模型 Profile ${id} 的 ${key} 必须是布尔值`); return value; }
function finite(value: unknown, id: string, key: string): number | undefined { if (value === undefined) return undefined; if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new Error(`模型 Profile ${id} 的 ${key} 必须是非负数字`); return value; }
function tierValue(value: string | undefined, key: string): TaskTier | undefined {
  const normalized = value?.trim();
  if (!normalized) return undefined;
  if (normalized === '0' || normalized === '1' || normalized === '2' || normalized === '3') return Number(normalized) as TaskTier;
  throw new Error(`${key} 必须是 0 到 3 的整数`);
}
function decimal(value: string | undefined, key: string): number | undefined {
  const normalized = value?.trim();
  if (!normalized) return undefined;
  const number = Number(normalized);
  if (Number.isFinite(number) && number >= 0) return number;
  throw new Error(`${key} 必须是非负数字`);
}
function positiveInteger(value: string | undefined, key: string): number | undefined {
  const normalized = value?.trim();
  if (!normalized) return undefined;
  const number = Number(normalized);
  if (Number.isSafeInteger(number) && number > 0) return number;
  throw new Error(`${key} 必须是正整数`);
}
function nonNegativeInteger(value: string | undefined, key: string): number | undefined {
  const normalized = value?.trim();
  if (!normalized) return undefined;
  const number = Number(normalized);
  if (Number.isSafeInteger(number) && number >= 0) return number;
  throw new Error(`${key} 必须是非负整数`);
}
function boolean(value: string | undefined, fallback: boolean, key: string): boolean {
  const normalized = value?.trim();
  if (!normalized) return fallback;
  if (normalized === 'true' || normalized === '1') return true;
  if (normalized === 'false' || normalized === '0') return false;
  throw new Error(`${key} 必须是 true、false、1 或 0`);
}
