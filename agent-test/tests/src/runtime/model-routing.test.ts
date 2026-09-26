import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { textMessage } from '../../../../src/core/messages.js';
import { ProviderError } from '../../../../src/providers/provider-error.js';
import type { ModelProvider, ProviderCapabilities, ProviderRequest, ProviderResult, ProviderStreamEvent } from '../../../../src/providers/types.js';
import { RoutedModelProvider, classifyTask } from '../../../../src/runtime/model-routing.js';
import { connectRoutedModelProviderFromEnv, routingMode } from '../../../../src/runtime/model-routing-config.js';
import type { RouteStatus } from '../../../../src/runtime/model-router.js';
import { ReactAgent } from '../../../../src/runtime/resumable-react-agent.js';
import { ToolExecutor } from '../../../../src/runtime/tool-executor.js';
import { ToolRegistry } from '../../../../src/runtime/tool-registry.js';
import { SessionRuntime } from '../../../../src/session/session-runtime.js';

const capabilities: ProviderCapabilities = {
  maxContextTokens: 32_000,
  supportsStreaming: false,
  supportsToolCalls: true,
  supportsParallelToolCalls: false,
  supportsStructuredOutput: true,
  supportsPromptCaching: false,
  supportsUsageReporting: true,
};

const primaryStatus: RouteStatus = {
  route: 'direct',
  requestedRoute: 'direct',
  state: 'ready',
  available: true,
  reasonCode: 'ready',
  reason: 'test',
  model: 'primary-model',
  privacy: 'full-context',
  capabilities,
};

class StubProvider implements ModelProvider {
  readonly capabilities: ProviderCapabilities;
  calls = 0;

  constructor(
    readonly model: string,
    private readonly handler: (request: ProviderRequest) => Promise<ProviderResult>,
    capabilitiesOverride: Partial<ProviderCapabilities> = {},
    private readonly streamHandler?: () => AsyncGenerator<ProviderStreamEvent>,
  ) {
    this.capabilities = { ...capabilities, ...capabilitiesOverride };
  }

  complete(request: ProviderRequest): Promise<ProviderResult> {
    this.calls += 1;
    return this.handler(request);
  }

  stream(): AsyncIterable<ProviderStreamEvent> {
    if (!this.streamHandler) throw new Error('stream unavailable');
    return this.streamHandler();
  }
}

function answer(model: string): Promise<ProviderResult> {
  return Promise.resolve({ output: [textMessage(`${model}-answer`, 'assistant', model)], stopReason: 'completed' });
}

test('classifies simple, coding, and complex tasks deterministically', () => {
  assert.deepEqual(classifyTask('解释这段代码').tier, 0);
  assert.deepEqual(classifyTask('修复这个 bug 并运行测试').tier, 2);
  const complex = classifyTask('为多文件架构迁移制定安全方案');
  assert.equal(complex.tier, 3);
  assert.equal(complex.phase, 'plan');
  assert.equal(complex.requiresTools, true);
});

test('selects a model at turn boundary and reports selection to ReactAgent events', async () => {
  const fast = new StubProvider('fast-model', () => answer('fast'));
  const quality = new StubProvider('quality-model', () => answer('quality'));
  const provider = new RoutedModelProvider([
    { id: 'fast', provider: fast, tier: 0, privacy: 'full-context', latencyHintMs: 10 },
    { id: 'quality', provider: quality, tier: 3, privacy: 'full-context', latencyHintMs: 100 },
  ], { mode: 'quality', defaultProfileId: 'fast' });
  const events: import('../../../../src/session/events.js').AgentEvent[] = [];
  const result = await new ReactAgent(provider, new ToolRegistry(), new ToolExecutor(new ToolRegistry()), {
    workspaceRoot: process.cwd(),
  }).run('设计复杂架构迁移方案', [], undefined, { onEvent: (event) => { events.push(event); } });

  assert.equal(result.answer, 'quality');
  assert.equal(events.some((event) => event.payload.type === 'route.selected'
    && event.payload.model === 'quality' && event.payload.mode === 'quality'), true);
  assert.equal(quality.calls, 1);
  assert.equal(fast.calls, 0);
});

test('falls back once after a retryable provider failure before text output', async () => {
  const primary = new StubProvider('primary-model', async () => {
    throw new ProviderError({ kind: 'network', message: 'offline', retryable: true });
  });
  const backup = new StubProvider('backup-model', () => answer('backup'));
  const provider = new RoutedModelProvider([
    { id: 'primary', provider: primary, tier: 2, privacy: 'full-context', estimatedInputCostPer1k: 0 },
    { id: 'backup', provider: backup, tier: 2, privacy: 'full-context', estimatedInputCostPer1k: 10 },
  ], { mode: 'balanced', defaultProfileId: 'primary' });
  provider.beginRun('修复 bug');
  const result = await provider.complete({ items: [textMessage('user', 'user', '修复 bug')] });

  assert.equal(result.output[0]?.type, 'message');
  assert.equal(provider.model, 'backup-model');
  assert.equal(primary.calls, 1);
  assert.equal(backup.calls, 1);
  assert.equal(provider.takeRouteEvents().some((event) => event.type === 'fallback'
    && event.fromModel === 'primary' && event.toModel === 'backup'), true);
});

test('pinned model and privacy mismatch prevent automatic fallback', async () => {
  const failing = new StubProvider('pinned-model', async () => {
    throw new ProviderError({ kind: 'timeout', message: 'timeout', retryable: true });
  });
  const differentPrivacy = new StubProvider('private-backup', () => answer('backup'));
  const pinned = new RoutedModelProvider([
    { id: 'pinned', provider: failing, tier: 2, privacy: 'full-context' },
    { id: 'backup', provider: differentPrivacy, tier: 2, privacy: 'metadata' },
  ], { mode: 'pinned:pinned', defaultProfileId: 'pinned' });
  pinned.beginRun('修复 bug');
  await assert.rejects(pinned.complete({ items: [] }), ProviderError);
  assert.equal(differentPrivacy.calls, 0);
  assert.equal(pinned.takeRouteEvents().some((event) => event.type === 'fallback_rejected'), true);
});

test('does not switch models after stream text has been emitted', async () => {
  const primary = new StubProvider(
    'stream-primary',
    () => answer('unused'),
    { supportsStreaming: true },
    async function* stream(): AsyncGenerator<ProviderStreamEvent> {
      yield { type: 'output_text.delta', delta: 'partial' };
      throw new ProviderError({ kind: 'network', message: 'interrupted', retryable: true });
    },
  );
  const backup = new StubProvider('stream-backup', () => answer('backup'), { supportsStreaming: true });
  const provider = new RoutedModelProvider([
    { id: 'primary', provider: primary, tier: 2, privacy: 'full-context', estimatedInputCostPer1k: 0 },
    { id: 'backup', provider: backup, tier: 2, privacy: 'full-context', estimatedInputCostPer1k: 10 },
  ], { mode: 'balanced', defaultProfileId: 'primary' });
  provider.beginRun('修复 bug');
  const received: string[] = [];
  await assert.rejects(async () => {
    for await (const event of provider.stream({ items: [] })) {
      if (event.type === 'output_text.delta') received.push(event.delta);
    }
  }, ProviderError);
  assert.deepEqual(received, ['partial']);
  assert.equal(backup.calls, 0);
  assert.equal(provider.takeRouteEvents().some((event) => event.type === 'fallback_rejected'
    && event.reason.includes('已输出文本')), true);
});

test('does not switch models once the Agent has entered the tool phase', async () => {
  const primary = new StubProvider('tool-primary', async () => {
    throw new ProviderError({ kind: 'upstream', message: 'failed', retryable: true });
  });
  const backup = new StubProvider('tool-backup', () => answer('backup'));
  const provider = new RoutedModelProvider([
    { id: 'primary', provider: primary, tier: 2, privacy: 'full-context', estimatedInputCostPer1k: 0 },
    { id: 'backup', provider: backup, tier: 2, privacy: 'full-context', estimatedInputCostPer1k: 10 },
  ], { mode: 'balanced', defaultProfileId: 'primary' });
  provider.beginRun('修复 bug');
  assert.equal(provider.model, 'tool-primary');
  provider.markToolsStarted();
  await assert.rejects(provider.complete({ items: [] }), ProviderError);
  assert.equal(backup.calls, 0);
  assert.equal(provider.takeRouteEvents().some((event) => event.type === 'fallback_rejected'
    && event.reason.includes('工具阶段')), true);
});

test('plan phase exposes only read tools and verifies mode state', async () => {
  let receivedTools: string[] = [];
  const model = new StubProvider('planner', async (request) => {
    receivedTools = request.tools?.map((tool) => tool.name) ?? [];
    return { output: [textMessage('answer', 'assistant', 'plan')], stopReason: 'completed' };
  });
  const provider = new RoutedModelProvider([
    { id: 'planner', provider: model, tier: 3, privacy: 'full-context' },
  ], { mode: 'quality', defaultProfileId: 'planner' });
  provider.configure('quality', 'plan');
  const registry = new ToolRegistry();
  for (const [name, permission] of [['read', 'workspace.read'], ['write', 'workspace.write'], ['test', 'process.exec']] as const) {
    registry.register({
      name,
      description: name,
      permission,
      inputSchema: { type: 'object', additionalProperties: false },
      execute: async () => ({ status: 'ok', content: 'ok', summary: 'ok', evidenceIds: [] }),
    });
  }
  const result = await new ReactAgent(provider, registry, new ToolExecutor(registry), {
    workspaceRoot: process.cwd(),
    permissions: new Set(['workspace.read', 'workspace.write', 'process.exec']),
  }).run('为迁移制定计划');
  assert.equal(result.answer, 'plan');
  assert.deepEqual(receivedTools, ['read']);
  assert.equal(provider.status().includes('phase=plan'), true);
});

test('session restores persisted model routing mode and phase', async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), 'echolens-routing-session-'));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const createAgent = (mode: 'off' | 'quality') => {
    const model = new StubProvider('session-model', () => answer('session'));
    const routed = new RoutedModelProvider([
      { id: 'default', provider: model, tier: 3, privacy: 'full-context' },
    ], { mode, defaultProfileId: 'default' });
    const registry = new ToolRegistry();
    return new ReactAgent(routed, registry, new ToolExecutor(registry), { workspaceRoot: workspace });
  };
  const first = await SessionRuntime.open(createAgent('off'), {
    rootDirectory: join(workspace, '.echolens', 'sessions'), workspaceRoot: workspace, sessionId: 'routing-session',
  });
  await first.configureModelRouting('quality', 'plan');
  await first.close();

  const restored = await SessionRuntime.open(createAgent('off'), {
    rootDirectory: join(workspace, '.echolens', 'sessions'), workspaceRoot: workspace, sessionId: 'routing-session',
  });
  t.after(() => restored.close());
  assert.equal(restored.modelRoutingStatus().includes('mode=quality'), true);
  assert.equal(restored.modelRoutingStatus().includes('phase=plan'), true);
});

test('routing configuration rejects invalid values instead of silently changing policy', async () => {
  assert.throws(() => routingMode('unknown'), /AGENT_ROUTING_MODE|模型模式/u);
  const primary = new StubProvider('primary-model', () => answer('primary'));
  await assert.rejects(
    connectRoutedModelProviderFromEnv(primary, primaryStatus, { AGENT_ROUTING_MAX_FALLBACKS: 'not-a-number' }),
    /AGENT_ROUTING_MAX_FALLBACKS/u,
  );
  await assert.rejects(
    connectRoutedModelProviderFromEnv(primary, primaryStatus, { AGENT_ROUTING_ALLOW_TIER_DOWNGRADE: 'maybe' }),
    /AGENT_ROUTING_ALLOW_TIER_DOWNGRADE/u,
  );
  await assert.rejects(
    connectRoutedModelProviderFromEnv(primary, primaryStatus, { AGENT_MODEL_PROFILES: '{' }),
    /AGENT_MODEL_PROFILES/u,
  );
  await assert.rejects(
    connectRoutedModelProviderFromEnv(primary, primaryStatus, {
      AGENT_MODEL_PROFILES: JSON.stringify([
        { id: 'duplicate', tier: 0, route: 'direct', model: 'a', providerUrl: 'http://localhost:3000', protocol: 'responses', credentialRef: 'env:A', privacy: 'full-context' },
        { id: 'duplicate', tier: 0, route: 'direct', model: 'b', providerUrl: 'http://localhost:3000', protocol: 'responses', credentialRef: 'env:B', privacy: 'full-context' },
      ]),
    }),
    /重复/u,
  );
  await assert.rejects(
    connectRoutedModelProviderFromEnv(primary, primaryStatus, {
      AGENT_MODEL_PROFILES: JSON.stringify([
        { id: 'invalid-privacy', tier: 0, route: 'direct', model: 'a', providerUrl: 'http://localhost:3000', protocol: 'responses', credentialRef: 'env:A', privacy: 'public' },
      ]),
    }),
    /privacy/u,
  );
  await assert.rejects(
    connectRoutedModelProviderFromEnv(primary, primaryStatus, { AGENT_ROUTING_MODE: 'pinned:missing' }),
    /不存在/u,
  );
});

test('routing environment parser validates optional profile fields and scalar bounds', async () => {
  assert.equal(routingMode(' fast '), 'fast');
  assert.equal(routingMode('pinned:profile_1'), 'pinned:profile_1');
  const primary = new StubProvider('primary-model', () => answer('primary'));
  const validProfiles = JSON.stringify([
    {
      id: 'direct-extra', tier: 1, route: 'direct', model: 'direct-model',
      providerUrl: 'http://localhost:3000', protocol: 'chat_completions', streaming: false,
      credentialRef: 'env:DIRECT_KEY', privacy: 'metadata', estimatedInputCostPer1k: 0.1,
      estimatedOutputCostPer1k: 0.2, latencyHintMs: 50,
      capabilities: { supportsStreaming: false, supportsToolCalls: true, maxContextTokens: 4096 },
    },
    {
      id: 'gateway-extra', tier: 3, route: 'gateway', model: 'gateway-model',
      gatewayUrl: 'http://localhost:3001', credentialRef: 'env:GATEWAY_KEY', privacy: 'evidence',
      capabilities: { supportsStructuredOutput: true },
    },
  ]);
  const connection = await connectRoutedModelProviderFromEnv(primary, primaryStatus, {
    AGENT_ROUTING_MODE: 'balanced', AGENT_ROUTING_DEFAULT_TIER: '1',
    AGENT_ROUTING_DEFAULT_INPUT_COST_PER_1K: '0.5', AGENT_ROUTING_DEFAULT_OUTPUT_COST_PER_1K: '1.5',
    AGENT_ROUTING_DEFAULT_LATENCY_MS: '25', AGENT_ROUTING_ALLOW_TIER_DOWNGRADE: '0',
    AGENT_ROUTING_MAX_FALLBACKS: '0', AGENT_MODEL_PROFILES: validProfiles,
  });
  assert.equal(connection.profiles[0]?.tier, 1);
  assert.equal(connection.profiles[0]?.estimatedInputCostPer1k, 0.5);
  assert.equal(connection.profiles[0]?.latencyHintMs, 25);
  assert.equal(connection.profiles.length, 1);
  assert.equal(connection.notices.length, 2);

  const invalidEnvs: Array<[string, string]> = [
    ['AGENT_ROUTING_DEFAULT_TIER', '4'],
    ['AGENT_ROUTING_DEFAULT_INPUT_COST_PER_1K', '-1'],
    ['AGENT_ROUTING_DEFAULT_LATENCY_MS', '0'],
    ['AGENT_ROUTING_ALLOW_TIER_DOWNGRADE', 'yes'],
    ['AGENT_ROUTING_MAX_FALLBACKS', '-1'],
  ];
  for (const [key, value] of invalidEnvs) {
    await assert.rejects(connectRoutedModelProviderFromEnv(primary, primaryStatus, { [key]: value }), new RegExp(key));
  }

  const invalidProfiles: unknown[] = [
    { id: 'bad-route', tier: 1, route: 'other', model: 'm', credentialRef: 'env:K', privacy: 'metadata' },
    { id: 'missing-model', tier: 1, route: 'direct', providerUrl: 'http://localhost', protocol: 'responses', credentialRef: 'env:K', privacy: 'metadata' },
    { id: 'bad-protocol', tier: 1, route: 'direct', model: 'm', providerUrl: 'http://localhost', protocol: 'chat', credentialRef: 'env:K', privacy: 'metadata' },
    { id: 'bad-capabilities', tier: 1, route: 'direct', model: 'm', providerUrl: 'http://localhost', protocol: 'responses', credentialRef: 'env:K', privacy: 'metadata', capabilities: { supportsToolCalls: 'yes' } },
  ];
  for (const profile of invalidProfiles) {
    await assert.rejects(connectRoutedModelProviderFromEnv(primary, primaryStatus, { AGENT_MODEL_PROFILES: JSON.stringify([profile]) }));
  }
});

test('unavailable extra profiles leave the primary route usable and report a notice', async () => {
  const primary = new StubProvider('primary-model', () => answer('primary'));
  const connection = await connectRoutedModelProviderFromEnv(primary, primaryStatus, {
    AGENT_ROUTING_MODE: 'auto',
    AGENT_MODEL_PROFILES: JSON.stringify([{
      id: 'missing-credential', tier: 0, route: 'direct', model: 'extra-model',
      providerUrl: 'http://localhost:3000', protocol: 'responses', credentialRef: 'env:EXTRA_API_KEY',
      privacy: 'full-context',
    }]),
  });
  assert.equal(connection.profiles.length, 1);
  assert.match(connection.notices[0] ?? '', /missing-credential/u);
  connection.provider.beginRun('解释路由');
  const result = await connection.provider.complete({ items: [] });
  assert.equal(result.output[0]?.type, 'message');
});

test('context overflow fallback requires a strictly larger context window', async () => {
  const primary = new StubProvider('short', async () => {
    throw new ProviderError({ kind: 'context_length', message: 'too long', retryable: false });
  }, { maxContextTokens: 8_192 });
  const sameSize = new StubProvider('same-size', () => answer('same'), { maxContextTokens: 8_192 });
  const long = new StubProvider('long', () => answer('long'), { maxContextTokens: 64_000 });
  const provider = new RoutedModelProvider([
    { id: 'primary', provider: primary, tier: 2, privacy: 'full-context', estimatedInputCostPer1k: 0 },
    { id: 'same', provider: sameSize, tier: 2, privacy: 'full-context', estimatedInputCostPer1k: 1 },
    { id: 'long', provider: long, tier: 2, privacy: 'full-context', estimatedInputCostPer1k: 2 },
  ], { mode: 'balanced', defaultProfileId: 'primary' });
  provider.beginRun('修复 bug');
  const result = await provider.complete({ items: [] });
  assert.equal(result.output[0]?.type, 'message');
  assert.equal(provider.model, 'long');
  assert.equal(sameSize.calls, 0);
  assert.equal(long.calls, 1);
});

test('tier downgrade is allowed only for fallback when explicitly enabled', async () => {
  const high = new StubProvider('high', async () => {
    throw new ProviderError({ kind: 'network', message: 'offline', retryable: true });
  });
  const lower = new StubProvider('lower', () => answer('lower'));
  const profiles = [
    { id: 'high', provider: high, tier: 2 as const, privacy: 'full-context' as const },
    { id: 'lower', provider: lower, tier: 1 as const, privacy: 'full-context' as const },
  ];
  const enabled = new RoutedModelProvider(profiles, {
    mode: 'balanced', defaultProfileId: 'high', allowTierDowngrade: true,
  });
  enabled.beginRun('修复 bug');
  await enabled.complete({ items: [] });
  assert.equal(enabled.model, 'lower');
  assert.equal(lower.calls, 1);

  const disabledHigh = new StubProvider('disabled-high', async () => {
    throw new ProviderError({ kind: 'network', message: 'offline', retryable: true });
  });
  const disabledLower = new StubProvider('disabled-lower', () => answer('lower'));
  const disabled = new RoutedModelProvider([
    { id: 'high', provider: disabledHigh, tier: 2, privacy: 'full-context' },
    { id: 'lower', provider: disabledLower, tier: 1, privacy: 'full-context' },
  ], { mode: 'balanced', defaultProfileId: 'high', allowTierDowngrade: false });
  disabled.beginRun('修复 bug');
  await assert.rejects(disabled.complete({ items: [] }), ProviderError);
  assert.equal(disabledLower.calls, 0);
});

test('complete retries eligible fallback profiles up to the configured limit', async () => {
  const first = new StubProvider('first', async () => {
    throw new ProviderError({ kind: 'network', message: 'offline', retryable: true });
  });
  const second = new StubProvider('second', async () => {
    throw new ProviderError({ kind: 'timeout', message: 'slow', retryable: true });
  });
  const third = new StubProvider('third', () => answer('third'));
  const provider = new RoutedModelProvider([
    { id: 'first', provider: first, tier: 2, privacy: 'full-context', latencyHintMs: 1 },
    { id: 'second', provider: second, tier: 2, privacy: 'full-context', latencyHintMs: 2 },
    { id: 'third', provider: third, tier: 2, privacy: 'full-context', latencyHintMs: 3 },
  ], { mode: 'balanced', defaultProfileId: 'first', maxFallbacks: 2 });
  provider.beginRun('修复 bug');
  const result = await provider.complete({ items: [] });
  assert.equal(result.output[0]?.type, 'message');
  assert.equal(provider.model, 'third');
  assert.equal(second.calls, 1);
  assert.equal(third.calls, 1);
});

test('repeated retryable failures open the model circuit for the cooldown period', async () => {
  let now = 1_000;
  const failing = new StubProvider('failing', async () => {
    throw new ProviderError({ kind: 'network', message: 'offline', retryable: true });
  });
  const backup = new StubProvider('backup', () => answer('backup'));
  const provider = new RoutedModelProvider([
    { id: 'failing', provider: failing, tier: 2, privacy: 'full-context', latencyHintMs: 1 },
    { id: 'backup', provider: backup, tier: 2, privacy: 'full-context', latencyHintMs: 2 },
  ], {
    mode: 'balanced', defaultProfileId: 'failing', now: () => now,
    circuitFailureThreshold: 2, circuitCooldownMs: 10_000,
  });
  provider.beginRun('修复 bug');
  await provider.complete({ items: [] });
  provider.beginRun('修复 bug');
  await provider.complete({ items: [] });
  provider.beginRun('修复 bug');
  assert.equal(provider.model, 'backup');
  assert.equal(failing.calls, 2);
  now += 10_000;
  provider.beginRun('修复 bug');
  assert.equal(provider.model, 'failing');
});

test('routing snapshot tracks known token costs and marks unknown usage explicitly', async () => {
  const priced = new StubProvider('priced', async () => ({
    output: [textMessage('answer', 'assistant', 'priced')],
    stopReason: 'completed',
    usage: { inputTokens: 1_000, outputTokens: 2_000, totalTokens: 3_000 },
  }));
  const provider = new RoutedModelProvider([
    {
      id: 'priced', provider: priced, tier: 0, privacy: 'full-context',
      estimatedInputCostPer1k: 0.5, estimatedOutputCostPer1k: 1,
    },
  ], { mode: 'auto', defaultProfileId: 'priced' });
  provider.beginRun('解释路由');
  await provider.complete({ items: [] });
  const snapshot = provider.snapshot();
  assert.equal(snapshot.runCostUsd, 2.5);
  assert.equal(snapshot.sessionCostUsd, 2.5);
  assert.equal(snapshot.costUnknown, false);
});

test('forked routing providers isolate session configuration and run state', () => {
  const primary = new StubProvider('primary', () => answer('primary'));
  const secondary = new StubProvider('secondary', () => answer('secondary'));
  const original = new RoutedModelProvider([
    { id: 'primary', provider: primary, tier: 2, privacy: 'full-context' },
    { id: 'secondary', provider: secondary, tier: 2, privacy: 'full-context' },
  ], { mode: 'balanced', defaultProfileId: 'primary' });
  original.configure('quality', 'plan');
  original.beginRun('修复 bug');
  const fork = original.fork();
  fork.configure('fast', 'execute');
  fork.beginRun('解释路由');
  assert.equal(original.status().includes('mode=quality'), true);
  assert.equal(original.status().includes('phase=plan'), true);
  assert.equal(fork.status().includes('mode=fast'), true);
  assert.equal(fork.status().includes('phase=execute'), true);
});

test('invalid session routing configuration is atomic', () => {
  const primary = new StubProvider('primary', () => answer('primary'));
  const provider = new RoutedModelProvider([
    { id: 'primary', provider: primary, tier: 2, privacy: 'full-context' },
  ], { mode: 'balanced', defaultProfileId: 'primary' });
  assert.throws(() => provider.configure('quality', 'invalid'), /阶段/u);
  assert.equal(provider.status().includes('mode=balanced'), true);
  assert.equal(provider.status().includes('phase=auto'), true);
});

test('rejects a pinned profile that is absent from the model pool', () => {
  const primary = new StubProvider('primary', () => answer('primary'));
  const provider = new RoutedModelProvider([
    { id: 'default', provider: primary, tier: 2, privacy: 'full-context' },
  ], { defaultProfileId: 'default' });
  assert.throws(() => provider.configure('pinned:missing'), /不存在/u);
  assert.throws(() => new RoutedModelProvider([
    { id: 'default', provider: primary, tier: 2, privacy: 'full-context' },
  ], { mode: 'pinned:missing', defaultProfileId: 'default' }), /不存在/u);
});

test('refuses to resume when the checkpoint model was removed from the pool', () => {
  const primary = new StubProvider('primary', () => answer('primary'));
  const provider = new RoutedModelProvider([
    { id: 'default', provider: primary, tier: 2, privacy: 'full-context' },
  ], { defaultProfileId: 'default' });
  assert.throws(() => provider.restore({
    version: 1,
    mode: 'auto',
    phase: 'execute',
    profileId: 'removed',
    tier: 2,
    requiresTools: true,
    locked: false,
    fallbacks: 0,
    runCostUsd: 0,
    sessionCostUsd: 0,
    costUnknown: false,
  }), /不在当前候选池/u);
});
