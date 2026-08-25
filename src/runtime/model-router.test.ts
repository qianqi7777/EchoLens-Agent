import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  CredentialContext,
  CredentialResolution,
  CredentialResolver,
} from '../credentials/index.js';
import { textMessage } from '../core/messages.js';
import { startGatewayOpenApiMock } from '../testing/openapi-mock.js';
import { ModelRouter } from './model-router.js';

class RecordingCredentialResolver implements CredentialResolver {
  readonly calls: Array<{ reference: string; context: CredentialContext }> = [];

  constructor(private readonly values: Record<string, string>) {}

  async resolve(reference: string, context: CredentialContext): Promise<CredentialResolution> {
    this.calls.push({ reference, context });
    const value = this.values[reference];
    return value ? { status: 'resolved', value } : { status: 'missing' };
  }
}

test('route selection is explicit and legacy local/cloud routes only produce migration diagnostics', () => {
  assert.equal(ModelRouter.fromEnv({}).inspect().reasonCode, 'route_not_configured');
  assert.equal(
    ModelRouter.fromEnv({ AGENT_MODEL_ROUTE: 'local' }).inspect().reasonCode,
    'legacy_route_local_removed',
  );
  assert.equal(
    ModelRouter.fromEnv({ AGENT_MODEL_ROUTE: 'cloud' }).inspect().reasonCode,
    'legacy_route_cloud_removed',
  );
  assert.equal(
    ModelRouter.fromEnv({
      AGENT_MODEL_ROUTE: 'direct',
      AGENT_DIRECT_BASE_URL: 'https://provider.example/v1',
      AGENT_DIRECT_MODEL: 'model',
      AGENT_DIRECT_PROTOCOL: 'chat_completions',
      AGENT_DIRECT_CREDENTIAL_REF: 'env:DIRECT_KEY',
    }).inspect().reasonCode,
    'privacy_not_configured',
  );
});

test('direct route resolves only its own credential and exposes explicit capabilities', async () => {
  const resolver = new RecordingCredentialResolver({
    'vault:direct': 'direct-secret',
    'vault:gateway': 'gateway-secret',
  });
  const router = ModelRouter.fromEnv({
    AGENT_MODEL_ROUTE: 'direct',
    AGENT_DIRECT_BASE_URL: 'https://provider.example/v1',
    AGENT_DIRECT_MODEL: 'direct-model',
    AGENT_DIRECT_PROTOCOL: 'responses',
    AGENT_DIRECT_CREDENTIAL_REF: 'vault:direct',
    AGENT_DIRECT_PRIVACY: 'full-context',
    AGENT_GATEWAY_URL: 'https://gateway.example',
    AGENT_GATEWAY_MODEL: 'gateway-model',
    AGENT_GATEWAY_CREDENTIAL_REF: 'vault:gateway',
    AGENT_GATEWAY_PRIVACY: 'metadata',
  }, {
    credentialResolver: resolver,
    directCapabilities: { maxContextTokens: 32_000, supportsStructuredOutput: true },
  });

  const connection = await router.connect();
  assert.ok(connection.provider);
  assert.equal(connection.status.state, 'ready');
  assert.equal(connection.status.route, 'direct');
  assert.equal(connection.status.protocol, 'responses');
  assert.equal(connection.status.privacy, 'full-context');
  assert.equal(connection.status.capabilities?.maxContextTokens, 32_000);
  assert.deepEqual(resolver.calls.map((call) => call.reference), ['vault:direct']);
});

test('gateway route uses its own credential, discovers capabilities, and executes the selected protocol', async () => {
  const mock = await startGatewayOpenApiMock();
  const resolver = new RecordingCredentialResolver({ 'vault:gateway': 'gateway-secret' });
  try {
    const router = ModelRouter.fromEnv({
      AGENT_MODEL_ROUTE: 'gateway',
      AGENT_GATEWAY_URL: mock.baseUrl,
      AGENT_GATEWAY_MODEL: 'deepseek-chat',
      AGENT_GATEWAY_CREDENTIAL_REF: 'vault:gateway',
      AGENT_GATEWAY_PRIVACY: 'full-context',
      AGENT_DIRECT_CREDENTIAL_REF: 'vault:direct',
    }, { credentialResolver: resolver });

    const connection = await router.connect();
    assert.ok(connection.provider);
    assert.equal(connection.status.state, 'ready');
    assert.equal(connection.status.route, 'gateway');
    assert.equal(connection.status.protocol, 'chat_completions');
    assert.equal(connection.status.capabilities?.supportsParallelToolCalls, true);
    assert.deepEqual(resolver.calls.map((call) => call.reference), ['vault:gateway']);

    const result = await connection.provider.complete({
      items: [textMessage('user-1', 'user', 'hello')],
    });
    assert.equal(result.stopReason, 'completed');
    assert.equal(mock.requests.at(-1)?.path, '/v1/chat/completions');
    assert.equal(mock.requests.at(-1)?.authorization, 'Bearer gateway-secret');
  } finally {
    await mock.close();
  }
});

test('gateway model discovery can select the Responses protocol without fallback', async () => {
  const mock = await startGatewayOpenApiMock();
  try {
    const router = ModelRouter.fromEnv({
      AGENT_MODEL_ROUTE: 'gateway',
      AGENT_GATEWAY_URL: mock.baseUrl,
      AGENT_GATEWAY_MODEL: 'responses-example',
      AGENT_GATEWAY_CREDENTIAL_REF: 'env:GATEWAY_TOKEN',
      AGENT_GATEWAY_PRIVACY: 'full-context',
      GATEWAY_TOKEN: 'gateway-token',
    });
    const connection = await router.connect();
    assert.ok(connection.provider);
    assert.equal(connection.status.protocol, 'responses');

    const result = await connection.provider.complete({
      items: [textMessage('user-1', 'user', 'hello')],
    });
    assert.equal(result.stopReason, 'completed');
    assert.equal(mock.requests.at(-1)?.path, '/v1/responses');
  } finally {
    await mock.close();
  }
});

test('gateway network failures are distinct from upstream model failures', async () => {
  const router = ModelRouter.fromEnv({
    AGENT_MODEL_ROUTE: 'gateway',
    AGENT_GATEWAY_URL: 'https://gateway.example',
    AGENT_GATEWAY_MODEL: 'deepseek-chat',
    AGENT_GATEWAY_CREDENTIAL_REF: 'env:GATEWAY_TOKEN',
    AGENT_GATEWAY_PRIVACY: 'full-context',
    GATEWAY_TOKEN: 'gateway-token',
  }, {
    fetch: async () => { throw new TypeError('connection refused'); },
  });

  const connection = await router.connect();
  assert.equal(connection.provider, null);
  assert.equal(connection.status.state, 'gateway_unreachable');
  assert.equal(connection.status.reasonCode, 'gateway_unreachable');
});

test('gateway signed-out, expired-token, and upstream failures remain distinct', async () => {
  const scenarios = [
    {
      selection: { 'GET /v1/auth/status': { example: 'signed_out' } },
      state: 'signed_out',
      reasonCode: 'signed_out',
    },
    {
      selection: { 'GET /v1/auth/status': { status: 401, example: 'token_expired' } },
      state: 'token_expired',
      reasonCode: 'token_expired',
    },
    {
      selection: { 'GET /v1/models': { status: 503 } },
      state: 'upstream_unavailable',
      reasonCode: 'upstream_unavailable',
    },
  ] as const;

  for (const scenario of scenarios) {
    const mock = await startGatewayOpenApiMock(scenario.selection);
    try {
      const router = ModelRouter.fromEnv({
        AGENT_MODEL_ROUTE: 'gateway',
        AGENT_GATEWAY_URL: mock.baseUrl,
        AGENT_GATEWAY_MODEL: 'deepseek-chat',
        AGENT_GATEWAY_CREDENTIAL_REF: 'env:GATEWAY_TOKEN',
        AGENT_GATEWAY_PRIVACY: 'full-context',
        GATEWAY_TOKEN: 'gateway-token',
      });
      const connection = await router.connect();
      assert.equal(connection.provider, null);
      assert.equal(connection.status.state, scenario.state);
      assert.equal(connection.status.reasonCode, scenario.reasonCode);
    } finally {
      await mock.close();
    }
  }
});

test('remote HTTP fails closed while implemented privacy routes connect explicitly', async () => {
  const insecure = ModelRouter.fromEnv({
    AGENT_MODEL_ROUTE: 'direct',
    AGENT_DIRECT_BASE_URL: 'http://provider.example/v1',
    AGENT_DIRECT_MODEL: 'model',
    AGENT_DIRECT_PROTOCOL: 'chat_completions',
    AGENT_DIRECT_CREDENTIAL_REF: 'env:DIRECT_KEY',
    AGENT_DIRECT_PRIVACY: 'full-context',
    DIRECT_KEY: 'secret',
  });
  assert.equal(insecure.inspect().reasonCode, 'direct_config_invalid');

  const resolver = new RecordingCredentialResolver({ 'vault:direct': 'secret' });
  const projected = ModelRouter.fromEnv({
    AGENT_MODEL_ROUTE: 'direct',
    AGENT_DIRECT_BASE_URL: 'https://provider.example/v1',
    AGENT_DIRECT_MODEL: 'model',
    AGENT_DIRECT_PROTOCOL: 'chat_completions',
    AGENT_DIRECT_CREDENTIAL_REF: 'vault:direct',
    AGENT_DIRECT_PRIVACY: 'evidence',
  }, { credentialResolver: resolver });
  const connection = await projected.connect();
  assert.ok(connection.provider);
  assert.equal(connection.status.state, 'ready');
  assert.equal(connection.status.privacy, 'evidence');
  assert.equal(projected.inspect().state, 'configured');
  assert.deepEqual(resolver.calls.map((call) => call.reference), ['vault:direct']);
});
