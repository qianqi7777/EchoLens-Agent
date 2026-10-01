import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { Permission } from '../../../../src/core/permissions.js';
import { DefaultProposedActionGuardrail } from '../../../../src/runtime/action-guardrail.js';
import type { ToolContext, ToolSpec } from '../../../../src/runtime/types.js';

const guardrail = new DefaultProposedActionGuardrail();

function tool(name: string, permission: ToolSpec['permission'], effect: NonNullable<ToolSpec['effect']>): ToolSpec {
  return {
    name,
    description: name,
    permission,
    effect,
    inputSchema: { type: 'object', additionalProperties: true },
    execute: async () => ({ status: 'ok', content: '', summary: '', evidenceIds: [] }),
  };
}

function context(workspaceRoot: string, permissions: Permission[], extra: Partial<ToolContext> = {}): ToolContext {
  return {
    workspaceRoot,
    allowedPermissions: new Set<Permission>(permissions),
    signal: new AbortController().signal,
    ...extra,
  };
}

test('Guardrail rejects nested constructor pollution keys', async () => {
  const root = await mkdtemp(join(tmpdir(), 'echolens-guardrail-matrix-'));
  try {
    const decision = await guardrail.evaluate(tool('read', 'workspace.read', 'read'),
      { nested: { constructor: { polluted: true } } }, context(root, ['workspace.read']));
    assert.equal(decision.decision, 'deny');
    assert.equal(decision.reasonCode, 'dangerous_argument_key');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Guardrail rejects JSON encoded __proto__ pollution keys', async () => {
  const root = await mkdtemp(join(tmpdir(), 'echolens-guardrail-matrix-'));
  try {
    const args = JSON.parse('{"nested":{"__proto__":{"polluted":true}}}') as Record<string, unknown>;
    const decision = await guardrail.evaluate(tool('read', 'workspace.read', 'read'), args, context(root, ['workspace.read']));
    assert.equal(decision.reasonCode, 'dangerous_argument_key');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Guardrail denies process tools in read-only profile', async () => {
  const root = await mkdtemp(join(tmpdir(), 'echolens-guardrail-matrix-'));
  try {
    const decision = await guardrail.evaluate(tool('exec', 'process.exec', 'process'), {}, context(root, ['process.exec'], { permissionProfile: 'read-only' }));
    assert.deepEqual({ decision: decision.decision, reasonCode: decision.reasonCode }, { decision: 'deny', reasonCode: 'permission_profile_read_only' });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Guardrail denies an ungranted permission before inspecting paths', async () => {
  const root = await mkdtemp(join(tmpdir(), 'echolens-guardrail-matrix-'));
  try {
    const decision = await guardrail.evaluate(tool('read', 'workspace.read', 'read'), { path: '../outside' }, context(root, []));
    assert.equal(decision.reasonCode, 'permission_denied');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Guardrail requires approval for auto-mode side effects', async () => {
  const root = await mkdtemp(join(tmpdir(), 'echolens-guardrail-matrix-'));
  try {
    const decision = await guardrail.evaluate(tool('write', 'workspace.write', 'write'), {}, context(root, ['workspace.write']));
    assert.deepEqual({ decision: decision.decision, reasonCode: decision.reasonCode }, { decision: 'require_approval', reasonCode: 'approval_required' });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Guardrail full profile allows workspace writes after permission checks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'echolens-guardrail-matrix-'));
  try {
    const decision = await guardrail.evaluate(tool('write', 'workspace.write', 'write'), {}, context(root, ['workspace.write'], { permissionProfile: 'full' }));
    assert.deepEqual({ decision: decision.decision, reasonCode: decision.reasonCode }, { decision: 'allow', reasonCode: 'permission_profile_full' });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Guardrail full profile allows process execution only when granted', async () => {
  const root = await mkdtemp(join(tmpdir(), 'echolens-guardrail-matrix-'));
  try {
    const decision = await guardrail.evaluate(tool('exec', 'process.exec', 'process'), {}, context(root, ['process.exec'], { permissionProfile: 'full' }));
    assert.equal(decision.reasonCode, 'permission_profile_full');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Guardrail keeps external effects behind approval', async () => {
  const root = await mkdtemp(join(tmpdir(), 'echolens-guardrail-matrix-'));
  try {
    const decision = await guardrail.evaluate(tool('publish', 'external.invoke', 'external'), {}, context(root, ['external.invoke']));
    assert.deepEqual({ decision: decision.decision, reasonCode: decision.reasonCode }, { decision: 'require_approval', reasonCode: 'approval_required' });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Guardrail checks every path in a multi-file Patch', async () => {
  const root = await mkdtemp(join(tmpdir(), 'echolens-guardrail-matrix-'));
  try {
    const decision = await guardrail.evaluate(tool('apply_patch', 'workspace.write', 'write'), {
      patch: { version: 1, operations: [
        { op: 'create', path: 'safe.txt', content: 'safe' },
        { op: 'create', path: '../outside.txt', content: 'blocked' },
      ] },
    }, context(root, ['workspace.write']));
    assert.deepEqual({ decision: decision.decision, reasonCode: decision.reasonCode }, { decision: 'deny', reasonCode: 'path_outside_workspace' });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Guardrail normalizes an approved read path to workspace-relative form', async () => {
  const root = await mkdtemp(join(tmpdir(), 'echolens-guardrail-matrix-'));
  try {
    await writeFile(join(root, 'readme.txt'), 'ok', 'utf8');
    const decision = await guardrail.evaluate(tool('read', 'workspace.read', 'read'), { path: 'readme.txt' }, context(root, ['workspace.read']));
    assert.deepEqual({ decision: decision.decision, reasonCode: decision.reasonCode, path: decision.normalizedArguments.path }, {
      decision: 'allow', reasonCode: 'workspace_path_verified', path: 'readme.txt',
    });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Guardrail denies a read of a missing path with a stable code', async () => {
  const root = await mkdtemp(join(tmpdir(), 'echolens-guardrail-matrix-'));
  try {
    const decision = await guardrail.evaluate(tool('read', 'workspace.read', 'read'), { path: 'missing.txt' }, context(root, ['workspace.read']));
    assert.equal(decision.reasonCode, 'path_not_found');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Guardrail rejects control characters before any read IO', async () => {
  const root = await mkdtemp(join(tmpdir(), 'echolens-guardrail-matrix-'));
  try {
    const decision = await guardrail.evaluate(tool('read', 'workspace.read', 'read'), { path: 'bad\u0001.txt' }, context(root, ['workspace.read']));
    assert.equal(decision.reasonCode, 'invalid_path');
  } finally { await rm(root, { recursive: true, force: true }); }
});
