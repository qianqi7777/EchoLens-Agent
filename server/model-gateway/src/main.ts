import { resolve } from 'node:path';
import { startGatewayServer } from './server.js';
import { GatewayStateStore } from './state-store.js';
import type {
  GatewayModel,
  GatewayProtocol,
  GatewayServerHandle,
  GatewayServerOptions,
  GatewayUpstream,
} from './types.js';

await main().catch((error) => {
  console.error(`EchoLens Gateway 启动失败：${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});

async function main(): Promise<void> {
  const protocols = parseProtocols(process.env.GATEWAY_PROTOCOLS);
  const defaultProtocol = parseDefaultProtocol(process.env.GATEWAY_DEFAULT_PROTOCOL, protocols);
  const modelId = process.env.GATEWAY_MODEL?.trim() || 'deepseek-chat';
  // 人工审批密钥必须显式配置；缺失即拒绝启动，防止设备码审批被绕过。
  const approvalSecret = required('GATEWAY_DEVICE_APPROVAL_SECRET');
  const upstreams = buildUpstreams(modelId, protocols);
  const model: GatewayModel = {
    id: modelId,
    protocols,
    default_protocol: defaultProtocol,
    capabilities: {
      max_context_tokens: integer('GATEWAY_MAX_CONTEXT_TOKENS', 64_000, 1),
      supports_streaming: true,
      supports_tool_calls: true,
      supports_parallel_tool_calls: true,
      supports_structured_output: protocols.includes('responses'),
      supports_prompt_caching: true,
      supports_usage_reporting: true,
    },
  };
  const options: GatewayServerOptions = {
    host: process.env.GATEWAY_HOST?.trim() || '127.0.0.1',
    port: integer('GATEWAY_PORT', 8787, 0),
    issuer: process.env.GATEWAY_ISSUER?.trim() || 'http://127.0.0.1:8787',
    deviceApprovalSecret: approvalSecret,
    maxConcurrentRequests: integer('GATEWAY_MAX_CONCURRENT_REQUESTS', 4, 1),
    maxRequestsPerMinute: integer('GATEWAY_MAX_REQUESTS_PER_MINUTE', 60, 1),
    monthlyRequestQuota: integer('GATEWAY_MONTHLY_REQUEST_QUOTA', 10_000, 0),
    monthlyTokenQuota: integer('GATEWAY_MONTHLY_TOKEN_QUOTA', 10_000_000, 0),
    maxUpstreamDurationMs: integer('GATEWAY_MAX_UPSTREAM_DURATION_MS', 120_000, 1),
    maxUpstreamResponseBytes: integer('GATEWAY_MAX_UPSTREAM_RESPONSE_BYTES', 64 * 1024 * 1024, 1),
    stateStore: new GatewayStateStore(
      process.env.GATEWAY_DATABASE_PATH?.trim() || resolve(process.cwd(), 'data', 'gateway.sqlite'),
    ),
    models: [model],
    upstreams,
    // 审计日志只记录请求号/账号/模型/状态/token 计数等元数据，
    // 不含 access/refresh token 或上游 API Key，构成日志数据边界。
    audit: (event) => console.log(JSON.stringify({ ...event, at: new Date().toISOString() })),
  };

  const gateway = await startGatewayServer(options);
  installShutdownHandlers(gateway);
  console.log(`EchoLens Gateway 已启动：${gateway.baseUrl}`);
  console.log(`模型：${model.id} | 上游：固定配置 | 协议：${model.protocols.join(', ')}`);
}

function parseProtocols(value: string | undefined): GatewayProtocol[] {
  const requested = (value ?? 'chat_completions').split(',').map((item) => item.trim()).filter(Boolean);
  const invalid = requested.filter((item) => item !== 'chat_completions' && item !== 'responses');
  if (requested.length === 0 || invalid.length > 0) {
    throw new Error('GATEWAY_PROTOCOLS 只能包含 chat_completions 或 responses');
  }
  return [...new Set(requested)] as GatewayProtocol[];
}

function parseDefaultProtocol(value: string | undefined, protocols: GatewayProtocol[]): GatewayProtocol {
  if (!value?.trim()) return protocols[0]!;
  if (value !== 'chat_completions' && value !== 'responses') {
    throw new Error('GATEWAY_DEFAULT_PROTOCOL 必须是 chat_completions 或 responses');
  }
  if (!protocols.includes(value)) throw new Error('GATEWAY_DEFAULT_PROTOCOL 必须包含在 GATEWAY_PROTOCOLS 中');
  return value;
}

// 上游一律取自服务端固定的环境变量配置，客户端无法指定目标地址或注入凭据；
// 缺少对应 API Key 时启动即失败 (fail-closed)，避免暴露半配置的认证边界。
function buildUpstreams(modelId: string, protocols: GatewayProtocol[]): Record<string, GatewayUpstream> {
  return Object.fromEntries(protocols.map((protocol) => {
    const suffix = protocol === 'responses' ? 'RESPONSES' : 'CHAT';
    const baseUrl = process.env[`GATEWAY_UPSTREAM_${suffix}_BASE_URL`]?.trim()
      || process.env.GATEWAY_UPSTREAM_BASE_URL?.trim()
      || (protocol === 'responses' ? 'https://api.openai.com/v1' : 'https://api.deepseek.com/v1');
    const apiKey = process.env[`GATEWAY_UPSTREAM_${suffix}_API_KEY`]?.trim()
      || process.env.GATEWAY_UPSTREAM_API_KEY?.trim();
    if (!apiKey) throw new Error(`缺少 ${protocol} 上游 API Key`);
    return [`${modelId}:${protocol}`, { baseUrl, apiKey, protocol }];
  }));
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`缺少 ${name}`);
  return value;
}

function integer(name: string, fallback: number, minimum: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`${name} 必须是不小于 ${minimum} 的整数`);
  }
  return value;
}

function installShutdownHandlers(gateway: GatewayServerHandle): void {
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`收到 ${signal}，正在关闭 Gateway。`);
    await gateway.close();
  };
  process.once('SIGINT', () => { void shutdown('SIGINT'); });
  process.once('SIGTERM', () => { void shutdown('SIGTERM'); });
}
