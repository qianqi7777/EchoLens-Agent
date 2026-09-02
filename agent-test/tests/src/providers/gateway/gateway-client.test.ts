// Gateway 客户端契约测试：部分用例起真实 Gateway 服务（port 0 随机端口），
// 部分用 OpenAPI Mock 校验协议字段。所有上游都指向 127.0.0.1:9（无监听端口），
// 确保测试不会真的发出网络请求。
import assert from 'node:assert/strict';
import test from 'node:test';
import { startGatewayOpenApiMock } from '../../../../support/openapi-mock.js';
import { GatewayClient, GatewayClientError } from '../../../../../src/providers/gateway/client.js';
import { startGatewayServer } from '../../../../../server/model-gateway/src/server.js';
import { GatewayTokenCredentialResolver } from '../../../../../src/credentials/gateway-token-credential-resolver.js';
import type { GatewayTokenStore, StoredGatewayTokens } from '../../../../../src/credentials/gateway-token-store.js';

test('GatewayClient 完成 Device Flow 轮询、账户查询和 Refresh Token 轮换', async (context) => {
  // randomToken 用闭包自增，保证每次颁发的令牌不同，Refresh 后才能断言“换了个新令牌”。
  const gateway = await startGatewayServer({
    port: 0,
    devicePollingIntervalSeconds: 0,
    models: [{
      id: 'deepseek-chat',
      protocols: ['chat_completions'],
      default_protocol: 'chat_completions',
      capabilities: {
        max_context_tokens: 64_000,
        supports_streaming: true,
        supports_tool_calls: true,
        supports_parallel_tool_calls: true,
        supports_structured_output: false,
        supports_prompt_caching: true,
        supports_usage_reporting: true,
      },
    }],
    upstreams: { 'deepseek-chat': { baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'test', protocol: 'chat_completions' } },
    randomToken: (() => { let index = 0; return () => `client-token-${++index}`; })(),
  });
  context.after(() => gateway.close());
  const client = new GatewayClient({ gatewayUrl: gateway.baseUrl, accessToken: '' });
  const device = await client.createDeviceAuthorization();
  // 先批准再轮询：pending 分支只有未批准时才会走到，断言在其后兜底。
  assert.equal(gateway.approveDeviceCode(device.deviceCode, 'acct-client', 'Client Test'), true);
  const token = await client.pollDeviceToken(device.deviceCode);
  assert.equal('pending' in token, false);
  if ('pending' in token) return;
  const accountClient = new GatewayClient({ gatewayUrl: gateway.baseUrl, accessToken: token.accessToken });
  const account = await accountClient.account();
  assert.equal(account.id, 'acct-client');
  // Refresh 必须轮换出不同的 access token，否则令牌轮换逻辑等于没生效。
  const refreshed = await accountClient.refreshToken(token.refreshToken!);
  assert.notEqual(refreshed.accessToken, token.accessToken);
  await accountClient.revokeToken(refreshed.accessToken);
});

test('Gateway Token Resolver 在 Access Token 到期前自动轮换', async (context) => {
  const gateway = await startGatewayServer({
    port: 0,
    devicePollingIntervalSeconds: 0,
    models: [{
      id: 'deepseek-chat', protocols: ['chat_completions'], default_protocol: 'chat_completions',
      capabilities: { max_context_tokens: 64_000, supports_streaming: true, supports_tool_calls: true, supports_parallel_tool_calls: true, supports_structured_output: false, supports_prompt_caching: true, supports_usage_reporting: true },
    }],
    upstreams: { 'deepseek-chat': { baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'test', protocol: 'chat_completions' } },
    randomToken: (() => { let index = 0; return () => `resolver-token-${++index}`; })(),
  });
  context.after(() => gateway.close());
  const client = new GatewayClient({ gatewayUrl: gateway.baseUrl, accessToken: '' });
  const device = await client.createDeviceAuthorization();
  gateway.approveDeviceCode(device.deviceCode);
  const issued = await client.pollDeviceToken(device.deviceCode);
  assert.equal('pending' in issued, false);
  if ('pending' in issued) return;
  let stored: StoredGatewayTokens | undefined = {
    accessToken: issued.accessToken,
    refreshToken: issued.refreshToken,
    // expiresAt 设成 epoch：强制 Resolver 认为令牌已过期，从而走轮换路径。
    expiresAt: new Date(0).toISOString(),
    scope: issued.scope,
  };
  const store: GatewayTokenStore = {
    async load() { return stored; },
    async save(value) { stored = value; },
    async clear() { stored = undefined; },
  };
  const resolved = await new GatewayTokenCredentialResolver(store).resolve('gateway-token:default', {
    purpose: 'gateway_access',
    audience: gateway.baseUrl,
  });
  assert.equal(resolved.status, 'resolved');
  // 解析结果必须是轮换后的新令牌，且新令牌已经回写存储。
  assert.notEqual(resolved.status === 'resolved' ? resolved.value : undefined, issued.accessToken);
  assert.equal(stored?.accessToken, resolved.status === 'resolved' ? resolved.value : undefined);
});

test('GatewayClient decodes auth state and model capabilities from the OpenAPI contract', async () => {
  const mock = await startGatewayOpenApiMock();
  try {
    const client = new GatewayClient({
      gatewayUrl: mock.baseUrl,
      accessToken: 'gateway-test-token',
    });
    const auth = await client.authStatus();
    const models = await client.listModels();

    assert.equal(auth.status, 'signed_in');
    assert.equal(auth.account?.displayName, 'Example User');
    assert.equal(models.models[0]?.id, 'deepseek-chat');
    assert.equal(models.models[0]?.defaultProtocol, 'chat_completions');
    assert.equal(models.models[0]?.capabilities.supportsToolCalls, true);
    assert.equal(models.models[0]?.capabilities.maxContextTokens, 64_000);
    assert.deepEqual(
      mock.requests.map((request) => request.authorization),
      ['Bearer gateway-test-token', 'Bearer gateway-test-token'],
    );
  } finally {
    await mock.close();
  }
});

test('OpenAPI Mock 覆盖 Device、Refresh 与 Revoke 客户端契约', async () => {
  const mock = await startGatewayOpenApiMock();
  try {
    const client = new GatewayClient({ gatewayUrl: mock.baseUrl, accessToken: '' });
    const device = await client.createDeviceAuthorization();
    const refreshed = await client.refreshToken('refresh-example');
    await client.revokeToken(refreshed.accessToken);

    assert.equal(device.deviceCode, 'device-code-example');
    assert.equal(refreshed.tokenType, 'Bearer');
    assert.deepEqual(
      mock.requests.map((request) => `${request.method} ${request.path}`),
      [
        'POST /oauth/device/authorization',
        'POST /oauth/token',
        'POST /oauth/revoke',
      ],
    );
  } finally {
    await mock.close();
  }
});

// 注入会抛错的 fetch 与固定时钟：即使网络与时间都不可控，也能稳定构造“过期 + 离线”场景。
test('过期 Gateway Token 网络刷新失败时保留 Gateway 不可达分类', async () => {
  let stored: StoredGatewayTokens | undefined = {
    accessToken: 'expired-access',
    refreshToken: 'expired-refresh',
    expiresAt: new Date(0).toISOString(),
    scope: ['models:read'],
  };
  const store: GatewayTokenStore = {
    async load() { return stored; },
    async save(value) { stored = value; },
    async clear() { stored = undefined; },
  };
  const resolver = new GatewayTokenCredentialResolver(
    store,
    async () => { throw new Error('offline'); },
    () => Date.parse('2026-08-26T00:00:00Z'),
  );

  // 网络失败必须归类为 gateway_unreachable，而不是被吞成“没有凭据”，
  // 这样上层才能区分“没登录”和“暂时连不上”。
  await assert.rejects(
    resolver.resolve('gateway-token:default', {
      purpose: 'gateway_access',
      audience: 'https://gateway.example.com',
    }),
    (error: unknown) => error instanceof GatewayClientError && error.code === 'gateway_unreachable',
  );
});

test('过期 Gateway Refresh Token 被服务端拒绝后要求重新登录', async () => {
  const store: GatewayTokenStore = {
    async load() {
      return {
        accessToken: 'expired-access',
        refreshToken: 'expired-refresh',
        expiresAt: new Date(0).toISOString(),
        scope: ['models:read'],
      };
    },
    // invalid_grant 意味着 refresh token 本身作废，任何保存都会留下不可用凭据。
    async save() { throw new Error('不应保存'); },
    async clear() {},
  };
  const resolver = new GatewayTokenCredentialResolver(
    store,
    async () => new Response(JSON.stringify({ error: 'invalid_grant' }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    }),
  );

  // 服务端明确拒绝（invalid_grant）时解析结果必须是 missing，等价于要求用户重新登录。
  const result = await resolver.resolve('gateway-token:default', {
    purpose: 'gateway_access',
    audience: 'https://gateway.example.com',
  });
  assert.deepEqual(result, { status: 'missing' });
});

// 错误码是客户端契约的一部分：调用方靠 code 决定是否重试或引导重新登录，
// 因此断言必须锁定具体 code 与 retryable 标志，而不是只断言“抛了错”。
test('GatewayClient preserves stable token and upstream error codes', async () => {
  const expiredMock = await startGatewayOpenApiMock({
    'GET /v1/auth/status': { status: 401, example: 'token_expired' },
  });
  try {
    const client = new GatewayClient({
      gatewayUrl: expiredMock.baseUrl,
      accessToken: 'expired-token',
    });
    await assert.rejects(client.authStatus(), (error: unknown) => {
      assert.ok(error instanceof GatewayClientError);
      assert.equal(error.code, 'token_expired');
      // 令牌过期重试没有意义：必须走重新认证，所以不可重试。
      assert.equal(error.retryable, false);
      return true;
    });
  } finally {
    await expiredMock.close();
  }

  const upstreamMock = await startGatewayOpenApiMock({
    'GET /v1/models': { status: 503 },
  });
  try {
    const client = new GatewayClient({
      gatewayUrl: upstreamMock.baseUrl,
      accessToken: 'gateway-test-token',
    });
    await assert.rejects(client.listModels(), (error: unknown) => {
      assert.ok(error instanceof GatewayClientError);
      assert.equal(error.code, 'upstream_unavailable');
      // 上游临时不可用值得重试：与令牌类错误形成对比。
      assert.equal(error.retryable, true);
      return true;
    });
  } finally {
    await upstreamMock.close();
  }
});
