import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { textMessage, type ToolResultItem } from '../../../../src/core/messages.js';
import { ContextManager } from '../../../../src/context/context-manager.js';

test('压缩保留用户约束与带证据的历史工具结果', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'echolens-compaction-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const manager = new ContextManager({ workspaceRoot: root, maxHistoryTurns: 1, maxInputTokens: 700, outputReserveTokens: 0 });
  const evidence: ToolResultItem = {
    type: 'tool_result', id: 'evidence-result', callId: 'evidence-call', toolName: 'read_file', status: 'ok',
    output: { id: 'evidence-output', kind: 'tool_output', content: '重要验证证据 '.repeat(80), source: { type: 'tool', toolName: 'read_file' }, trust: 'untrusted', redactions: [] },
    summary: '验证证据', evidenceIds: ['file:src/index.ts:1'],
  };
  const constraint = textMessage('constraint', 'user', '必须保留这个用户约束：不要修改 API 契约。');
  const built = await manager.build([
    textMessage('noise', 'user', '旧的无关历史 '.repeat(80)),
    constraint, evidence,
    textMessage('latest', 'user', `当前待办：${'继续分析 '.repeat(80)}`),
  ], { privacy: 'full-context', providerMaxContextTokens: 700, runtimePermissions: new Set(), protectedItemIds: ['constraint'] });
  const ids = new Set(built.items.map((item) => item.id));
  assert.equal(ids.has('constraint'), true);
  assert.equal(ids.has('evidence-result'), true);
  assert.equal(ids.has('latest'), true);
  assert.equal(built.compacted, true);
  const constraintItem = built.items.find((item) => item.id === 'constraint');
  assert.equal(constraintItem?.type, 'message');
  assert.match(constraintItem?.type === 'message' ? constraintItem.content[0]?.text ?? '' : '', /不要修改 API 契约/u);
  const evidenceItem = built.items.find((item) => item.id === 'evidence-result');
  assert.equal(evidenceItem?.type, 'tool_result');
  assert.match(evidenceItem?.type === 'tool_result' ? evidenceItem.output.content : '', /重要验证证据/u);
});

test('受保护内容超过预算时显式失败，而不是静默丢弃', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'echolens-compaction-overflow-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const manager = new ContextManager({ workspaceRoot: root, maxInputTokens: 512, outputReserveTokens: 0 });
  await assert.rejects(manager.build([
    textMessage('constraint', 'user', '必须保留 '.repeat(1000)),
  ], { privacy: 'full-context', providerMaxContextTokens: 512, runtimePermissions: new Set() }), /Context 超过输入预算/u);
});
