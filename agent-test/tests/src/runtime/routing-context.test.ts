import assert from 'node:assert/strict';
import test from 'node:test';
import { textMessage } from '../../../../src/core/messages.js';
import type { ModelProvider, ProviderCapabilities, ProviderRequest, ProviderResult } from '../../../../src/providers/types.js';
import { RoutedModelProvider } from '../../../../src/runtime/model-routing.js';

class Provider implements ModelProvider {
  readonly capabilities: ProviderCapabilities;
  constructor(readonly model: string, maxContextTokens: number) {
    this.capabilities = { maxContextTokens, supportsStreaming: false, supportsToolCalls: true, supportsParallelToolCalls: false, supportsStructuredOutput: true, supportsPromptCaching: false, supportsUsageReporting: true };
  }
  complete(_request: ProviderRequest): Promise<ProviderResult> { return Promise.resolve({ output: [textMessage('answer', 'assistant', this.model)], stopReason: 'completed' }); }
}

test('路由初选按上下文容量排除过小窗口并记录原因', () => {
  const small = new Provider('small', 5_000);
  const large = new Provider('large', 32_000);
  const routed = new RoutedModelProvider([
    { id: 'small', provider: small, tier: 2, privacy: 'full-context' },
    { id: 'large', provider: large, tier: 2, privacy: 'full-context' },
  ], { mode: 'balanced', defaultProfileId: 'small' });
  routed.beginRun('实现一个功能并分析 ' + 'x'.repeat(20_000));
  assert.equal(routed.model, 'large');
  const selected = routed.takeRouteEvents().find((event) => event.type === 'selected');
  assert.ok(selected && selected.type === 'selected');
  assert.deepEqual(selected.excluded, [{ id: 'small', reason: 'context_too_small' }]);
});

test('短输入仍保留原有初选行为', () => {
  const small = new Provider('small', 8_192);
  const large = new Provider('large', 32_000);
  const routed = new RoutedModelProvider([
    { id: 'small', provider: small, tier: 2, privacy: 'full-context', latencyHintMs: 1 },
    { id: 'large', provider: large, tier: 2, privacy: 'full-context', latencyHintMs: 100 },
  ], { mode: 'fast', defaultProfileId: 'small' });
  routed.beginRun('修复 bug');
  assert.equal(routed.model, 'small');
});
