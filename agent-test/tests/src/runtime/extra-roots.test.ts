import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { loadAuthorizedRoots } from '../../../../src/runtime/authorized-roots.js';
import { DefaultProposedActionGuardrail } from '../../../../src/runtime/action-guardrail.js';
import { PathPolicy, PathPolicyError } from '../../../../src/runtime/path-policy.js';
import type { ToolSpec } from '../../../../src/runtime/types.js';

const patchTool: ToolSpec = {
  name: 'apply_patch', description: 'patch', permission: 'workspace.write', effect: 'write',
  inputSchema: { type: 'object', additionalProperties: true }, execute: async () => ({ status: 'ok', content: '', summary: '', evidenceIds: [] }),
};

test('未配置授权根时，工作区外路径仍硬拒绝', async (t) => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'echolens-extra-root-workspace-'));
  const outside = await mkdtemp(path.join(tmpdir(), 'echolens-extra-root-outside-'));
  t.after(() => Promise.all([rm(workspace, { recursive: true, force: true }), rm(outside, { recursive: true, force: true })]));
  const target = path.join(outside, 'file.txt'); await writeFile(target, 'outside\n');
  const policy = await PathPolicy.create(workspace);
  await assert.rejects(() => policy.readTextFile(target), (error: unknown) => error instanceof PathPolicyError && error.code === 'path_outside_workspace');
  const decision = await new DefaultProposedActionGuardrail().evaluate(patchTool, {
    patch: { version: 1, operations: [{ op: 'create', path: target, content: 'blocked' }] },
  }, toolContext(workspace));
  assert.equal(decision.decision, 'deny');
  assert.equal(decision.reasonCode, 'path_outside_workspace');
});

test('显式授权根允许读取但写入逐次进入审批，且只读根拒绝写入', async (t) => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'echolens-extra-root-workspace-'));
  const outside = await mkdtemp(path.join(tmpdir(), 'echolens-extra-root-outside-'));
  t.after(() => Promise.all([rm(workspace, { recursive: true, force: true }), rm(outside, { recursive: true, force: true })]));
  await mkdir(path.join(workspace, '.echolens'), { recursive: true });
  const target = path.join(outside, 'file.txt'); await writeFile(target, 'outside\n');
  await writeFile(path.join(workspace, '.echolens', 'roots.json'), JSON.stringify({ version: 1, roots: [{ path: outside, allowWrite: true, note: 'test root' }] }));
  const policy = await PathPolicy.create(workspace);
  assert.equal((await policy.readTextFile(target)).content, 'outside\n');
  const guardrail = new DefaultProposedActionGuardrail();
  const decision = await guardrail.evaluate(patchTool, {
    patch: { version: 1, operations: [{ op: 'create', path: target, content: 'new' }] },
  }, toolContext(workspace));
  assert.equal(decision.decision, 'require_approval');
  assert.equal(decision.reasonCode, 'outside_workspace_write_approval');
  assert.match(decision.reason, /工作区外/);

  await writeFile(path.join(workspace, '.echolens', 'roots.json'), JSON.stringify({ version: 1, roots: [{ path: outside, allowWrite: false }] }));
  const readOnlyPolicy = await PathPolicy.create(workspace);
  await assert.rejects(() => readOnlyPolicy.openFileForWrite(target), (error: unknown) => error instanceof PathPolicyError && error.code === 'path_outside_workspace');
});

test('授权根不允许重解析点、.git 与越界语法', async (t) => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'echolens-extra-root-workspace-'));
  const outside = await mkdtemp(path.join(tmpdir(), 'echolens-extra-root-outside-'));
  const linked = path.join(workspace, '.echolens', 'linked-root');
  t.after(() => Promise.all([rm(workspace, { recursive: true, force: true }), rm(outside, { recursive: true, force: true })]));
  await mkdir(path.join(workspace, '.echolens'), { recursive: true });
  const linkResult = await symlink(outside, linked, process.platform === 'win32' ? 'junction' : 'dir').then(() => true).catch(() => false);
  await writeFile(path.join(workspace, '.echolens', 'roots.json'), JSON.stringify({ version: 1, roots: [{ path: linked, allowWrite: true }] }));
  const loaded = await loadAuthorizedRoots(workspace);
  // 授权根自身是 Junction/符号链接时必须拒绝加载；当前账户若无法创建链接，
  // 则仅验证配置读取不会扩大访问范围，并保留 warning 断言。
  assert.equal(linkResult ? loaded.roots.some((root) => root.canonicalPath === outside) : true, false);
  assert.ok(loaded.warnings.length >= 1);
  const gitConfig = path.join(outside, '.git', 'config');
  await mkdir(path.dirname(gitConfig), { recursive: true }); await writeFile(gitConfig, 'secret');
  // 链接根被拒绝后，再用真实目录作为授权根验证其内部敏感目录仍不可访问。
  await writeFile(path.join(workspace, '.echolens', 'roots.json'), JSON.stringify({ version: 1, roots: [{ path: outside, allowWrite: true }] }));
  const policy = await PathPolicy.create(workspace);
  await assert.rejects(() => policy.readTextFile(gitConfig), (error: unknown) => error instanceof PathPolicyError && error.code === 'git_metadata_denied');
  await assert.rejects(() => policy.readTextFile(path.join(outside, '..', 'escape.txt')), (error: unknown) => error instanceof PathPolicyError && error.code === 'path_outside_workspace');
  if (linkResult) assert.equal((await lstat(linked)).isSymbolicLink(), true);
});

test('授权根配置目录自身为链接时不加载外部配置', async (t) => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'echolens-extra-root-workspace-'));
  const outside = await mkdtemp(path.join(tmpdir(), 'echolens-extra-root-outside-'));
  t.after(() => Promise.all([rm(workspace, { recursive: true, force: true }), rm(outside, { recursive: true, force: true })]));
  await writeFile(path.join(outside, 'roots.json'), JSON.stringify({ version: 1, roots: [{ path: outside, allowWrite: true }] }));
  const privateLink = path.join(workspace, '.echolens');
  const linkResult = await symlink(outside, privateLink, process.platform === 'win32' ? 'junction' : 'dir').then(() => true).catch(() => false);
  if (!linkResult) {
    t.diagnostic('当前环境不支持创建 .echolens Junction/符号链接；跳过该能力分支。');
    return;
  }
  const loaded = await loadAuthorizedRoots(workspace);
  assert.equal(loaded.roots.length, 0);
  assert.ok(loaded.warnings.length >= 1);
  const policy = await PathPolicy.create(workspace);
  assert.ok(policy.authorizedRootWarnings.length >= 1);
});

test('PathPolicy 仅在显式可写授权根内创建和删除文件', async (t) => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'echolens-extra-root-write-workspace-'));
  const outside = await mkdtemp(path.join(tmpdir(), 'echolens-extra-root-write-outside-'));
  t.after(() => Promise.all([rm(workspace, { recursive: true, force: true }), rm(outside, { recursive: true, force: true })]));
  await mkdir(path.join(workspace, '.echolens'));
  await writeFile(path.join(workspace, '.echolens', 'roots.json'), JSON.stringify({
    version: 1, roots: [{ path: outside, allowWrite: true }],
  }));
  const policy = await PathPolicy.create(workspace);
  const target = path.join(outside, 'authorized.txt');
  assert.equal(policy.classifyPath(target).scope, 'authorized');
  assert.equal(policy.classifyPath(path.join(outside, '..', 'not-authorized.txt')).scope, 'denied');
  const created = await policy.createFile(target);
  await created.handle.writeFile('authorized content');
  await created.handle.close();
  assert.equal((await policy.readTextFile(target)).content, 'authorized content');
  const writable = await policy.openFileForWrite(target);
  await writable.handle.close();
  assert.equal(await policy.deleteFile(target), target);
  await assert.rejects(policy.readTextFile(target), (error: unknown) => error instanceof PathPolicyError && error.code === 'path_not_found');

  await writeFile(path.join(workspace, '.echolens', 'roots.json'), JSON.stringify({
    version: 1, roots: [{ path: outside, allowWrite: false }],
  }));
  const readOnly = await PathPolicy.create(workspace);
  assert.equal(readOnly.classifyPath(target).scope, 'authorized');
  await assert.rejects(readOnly.createFile(target), (error: unknown) => error instanceof PathPolicyError && error.code === 'path_outside_workspace');
});

function toolContext(workspaceRoot: string) {
  return { workspaceRoot, allowedPermissions: new Set(['workspace.write' as const]), signal: new AbortController().signal };
}
