import assert from 'node:assert/strict';
import test from 'node:test';
import { DefaultProposedActionGuardrail } from '../../../../src/runtime/action-guardrail.js';
import { parsePermissionProfile } from '../../../../src/runtime/permission-profile.js';
import type { ToolSpec } from '../../../../src/runtime/types.js';

const guardrail = new DefaultProposedActionGuardrail();
const context = (profile: 'read-only' | 'auto' | 'full') => ({
  workspaceRoot: '.', permissionProfile: profile, allowedPermissions: new Set(['workspace.read', 'workspace.write', 'process.exec', 'network.request', 'external.invoke'] as const), signal: new AbortController().signal,
});
const tool = (effect: NonNullable<ToolSpec['effect']>, permission: ToolSpec['permission']): ToolSpec => ({
  name: `${effect}-tool`, description: effect, permission, effect,
  inputSchema: { type: 'object', additionalProperties: false }, execute: async () => ({ status: 'ok', content: '', summary: '', evidenceIds: [] }),
});

test('三档权限边界：read-only 收紧，auto 保持审批，full 只自动放行写入/命令', async () => {
  const write = tool('write', 'workspace.write');
  const process = tool('process', 'process.exec');
  const network = tool('network', 'network.request');
  assert.equal((await guardrail.evaluate(write, {}, context('read-only'))).reasonCode, 'permission_profile_read_only');
  assert.equal((await guardrail.evaluate(write, {}, context('auto'))).decision, 'require_approval');
  assert.equal((await guardrail.evaluate(write, {}, context('full'))).decision, 'allow');
  assert.equal((await guardrail.evaluate(process, {}, context('full'))).decision, 'allow');
  assert.equal((await guardrail.evaluate(network, {}, context('full'))).decision, 'require_approval');
});

test('档位解析默认 auto，非法值失败关闭', () => {
  assert.equal(parsePermissionProfile(undefined), 'auto');
  assert.equal(parsePermissionProfile('full'), 'full');
  assert.throws(() => parsePermissionProfile('unsafe'), /必须为/u);
});
