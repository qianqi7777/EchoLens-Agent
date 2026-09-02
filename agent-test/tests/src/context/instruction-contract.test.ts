import assert from 'node:assert/strict';
import test from 'node:test';
import type { Permission } from '../../../../src/core/permissions.js';
import {
  evaluateInstructionPermissions,
  type InstructionPermissionDirective,
} from '../../../../src/context/instruction-types.js';

const granted = new Set<Permission>([
  'workspace.read',
  'workspace.write',
  'process.exec',
  'network.request',
]);

function directive(
  id: string,
  effect: InstructionPermissionDirective['effect'],
  permission: Permission,
): InstructionPermissionDirective {
  return {
    id,
    sourceId: `source:${id}`,
    sourceTrust: 'repository',
    effect,
    permission,
    reason: `rule ${id}`,
  };
}

test('instruction deny directives only remove Runtime-granted permissions', () => {
  const result = evaluateInstructionPermissions(granted, [
    directive('deny-write', 'deny', 'workspace.write'),
    directive('deny-network', 'deny', 'network.request'),
  ]);

  assert.deepEqual(result.effectivePermissions, ['process.exec', 'workspace.read']);
  assert.deepEqual(result.deniedPermissions, ['network.request', 'workspace.write']);
  assert.deepEqual(result.approvalRequests, []);
});

test('request_approval gates a permission even when Runtime granted it', () => {
  const result = evaluateInstructionPermissions(granted, [
    directive('request-process', 'request_approval', 'process.exec'),
  ]);

  assert.deepEqual(result.effectivePermissions, [
    'network.request',
    'workspace.read',
    'workspace.write',
  ]);
  assert.deepEqual(result.approvalRequests, [{
    permission: 'process.exec',
    sourceIds: ['source:request-process'],
    reasons: ['rule request-process'],
  }]);
});

// 先 deny 后 request_approval：deny 优先且不可被后续申请撤销，
// 因此 approvalRequests 为空，process.exec 仍被拒绝。
test('a later approval request cannot restore an earlier denied permission', () => {
  const result = evaluateInstructionPermissions(granted, [
    directive('deny-process', 'deny', 'process.exec'),
    directive('request-process', 'request_approval', 'process.exec'),
  ]);

  assert.equal(result.effectivePermissions.includes('process.exec'), false);
  assert.deepEqual(result.deniedPermissions, ['process.exec']);
  assert.deepEqual(result.approvalRequests, []);
});

// 只有 workspace.read 被运行时授权，规则却申请 process.exec：
// 指令不能新增权限，超出运行时权限上限的申请被拒绝并记录到 rejectedDirectiveIds。
test('approval requests outside the Runtime permission ceiling are rejected', () => {
  const result = evaluateInstructionPermissions(new Set<Permission>(['workspace.read']), [
    directive('request-process', 'request_approval', 'process.exec'),
  ]);

  assert.deepEqual(result.effectivePermissions, ['workspace.read']);
  assert.deepEqual(result.approvalRequests, []);
  assert.deepEqual(result.rejectedDirectiveIds, ['request-process']);
});

// Fixture：把 effect 强转为 'allow'，模拟不可信规则文件中的未知或非法效果。
// 必须 fail-closed：该指令被拒绝、不授予任何权限，并写入 rejectedDirectiveIds。
test('unknown permission effects fail closed and are reported', () => {
  const invalid = {
    ...directive('attempt-allow', 'request_approval', 'workspace.write'),
    effect: 'allow',
  } as unknown as InstructionPermissionDirective;
  const result = evaluateInstructionPermissions(new Set<Permission>(['workspace.read']), [invalid]);

  assert.deepEqual(result.effectivePermissions, ['workspace.read']);
  assert.deepEqual(result.approvalRequests, []);
  assert.deepEqual(result.rejectedDirectiveIds, ['attempt-allow']);
});

test('v0.3 instruction policy uses root-to-target merge and one file per directory', () => {
  const policy = {
    globalFileOrder: ['AGENTS.override.md', 'AGENTS.md'],
    directoryFileOrder: ['AGENTS.override.md', 'AGENTS.md', 'configured_fallbacks'],
    mergeDirection: 'global_then_root_to_target',
    oneFilePerDirectory: true,
  };
  assert.equal(policy.mergeDirection, 'global_then_root_to_target');
  assert.equal(policy.oneFilePerDirectory, true);
  assert.equal(policy.directoryFileOrder[0], 'AGENTS.override.md');
});
