import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import type { Permission } from '../core/permissions.js';
import {
  evaluateInstructionPermissions,
  type InstructionPermissionDirective,
} from './instruction-types.js';

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

test('a later approval request cannot restore an earlier denied permission', () => {
  const result = evaluateInstructionPermissions(granted, [
    directive('deny-process', 'deny', 'process.exec'),
    directive('request-process', 'request_approval', 'process.exec'),
  ]);

  assert.equal(result.effectivePermissions.includes('process.exec'), false);
  assert.deepEqual(result.deniedPermissions, ['process.exec']);
  assert.deepEqual(result.approvalRequests, []);
});

test('approval requests outside the Runtime permission ceiling are rejected', () => {
  const result = evaluateInstructionPermissions(new Set<Permission>(['workspace.read']), [
    directive('request-process', 'request_approval', 'process.exec'),
  ]);

  assert.deepEqual(result.effectivePermissions, ['workspace.read']);
  assert.deepEqual(result.approvalRequests, []);
  assert.deepEqual(result.rejectedDirectiveIds, ['request-process']);
});

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

test('v0.2 exposes contracts without loading AGENTS.md from the filesystem', async () => {
  const contextDirectory = path.resolve('src/context');
  const contextFiles = (await readdir(contextDirectory))
    .filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts'));
  for (const file of contextFiles) {
    const source = await readFile(path.join(contextDirectory, file), 'utf8');
    assert.equal(source.includes('node:fs'), false, `${file} must not import node:fs in v0.2`);
    assert.equal(source.includes("from 'fs'"), false, `${file} must not import fs in v0.2`);
    assert.equal(source.includes('from "fs"'), false, `${file} must not import fs in v0.2`);
  }

  const runtimeDirectory = path.resolve('src/runtime');
  const runtimeFiles = (await readdir(runtimeDirectory))
    .filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts'));
  for (const file of runtimeFiles) {
    const source = await readFile(path.join(runtimeDirectory, file), 'utf8');
    assert.equal(source.includes('AGENTS.md'), false, `${file} must not load AGENTS.md in v0.2`);
  }
});
