import assert from 'node:assert/strict';
import test from 'node:test';
import { clamp01, verifyClaims } from '../../../../src/runtime/verifier.js';

test('Verifier only accepts claims with known nodes and evidence', () => {
  const result = verifyClaims([
    {
      name: '已验证声明',
      nodeId: 'node-1',
      reason: '由工具结果支持',
      confidence: 1.5,
      evidenceIds: ['evidence-1'],
    },
    {
      name: '缺少节点',
      nodeId: 'node-missing',
      reason: '不能只凭文本接受',
      confidence: 0.8,
      evidenceIds: ['evidence-1'],
    },
    {
      name: '缺少证据',
      nodeId: 'node-1',
      reason: '没有可追溯证据',
      confidence: 0.8,
      evidenceIds: ['evidence-missing'],
    },
  ], new Set(['node-1']), new Set(['evidence-1']));

  assert.equal(result.accepted.length, 1);
  assert.equal(result.accepted[0]?.confidence, 1);
  assert.deepEqual(result.unresolved, [
    '缺少节点（待核查：缺少节点或证据）',
    '缺少证据（待核查：缺少节点或证据）',
  ]);
  assert.match(result.trace[0]?.message ?? '', /检查 3 条，保留 1 条，拒绝 2 条/u);
});

test('Verifier clamps invalid confidence values fail-closed', () => {
  assert.equal(clamp01(-1), 0);
  assert.equal(clamp01(2), 1);
  assert.equal(clamp01(Number.NaN), 0);
  assert.equal(clamp01(Number.POSITIVE_INFINITY), 0);
  assert.equal(clamp01('0.5'), 0);
  assert.equal(clamp01(0.5), 0.5);
});
