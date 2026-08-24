import assert from 'node:assert/strict';
import test from 'node:test';
import { startGatewayOpenApiMock } from '../../testing/openapi-mock.js';
import { GatewayClient, GatewayClientError } from './client.js';

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
