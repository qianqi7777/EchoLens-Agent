import assert from 'node:assert/strict';
import test from 'node:test';
import { startGatewayOpenApiMock } from '../../testing/openapi-mock.js';
import { GatewayClient, GatewayClientError } from './client.js';
import { startGatewayServer } from '../../../server/model-gateway/src/server.js';
import { GatewayTokenCredentialResolver } from '../../credentials/gateway-token-credential-resolver.js';
import type { GatewayTokenStore, StoredGatewayTokens } from '../../credentials/gateway-token-store.js';

test('GatewayClient 完成 Device Flow 轮询、账户查询和 Refresh Token 轮换', async (context) => {
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
  assert.equal(gateway.approveDeviceCode(device.deviceCode, 'acct-client', 'Client Test'), true);
  const token = await client.pollDeviceToken(device.deviceCode);
  assert.equal('pending' in token, false);
  if ('pending' in token) return;
  const accountClient = new GatewayClient({ gatewayUrl: gateway.baseUrl, accessToken: token.accessToken });
  const account = await accountClient.account();
  assert.equal(account.id, 'acct-client');
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

test('过期 Gateway Token 刷新失败后不再返回无效 Access Token', async () => {
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

  const result = await resolver.resolve('gateway-token:default', {
    purpose: 'gateway_access',
    audience: 'https://gateway.example.com',
  });
  assert.deepEqual(result, { status: 'missing' });
});

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
      assert.equal(error.retryable, true);
      return true;
    });
  } finally {
    await upstreamMock.close();
  }
});
