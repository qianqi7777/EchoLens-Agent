import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { previewApprovalRequest } from '../approval-preview.js';
import { applyPatch } from '../runtime/structured-patch.js';
import { collectSandboxArtifacts, loadSandboxArtifactBundle } from './artifact-store.js';
import { SandboxError } from './types.js';
import { FileSystemWorkspaceStager } from './workspace-stager.js';

test('Artifact Bundle 收集文本变化并生成可安全应用的结构化 Patch', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'echolens-artifacts-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'empty.txt'), '');
  await writeFile(join(root, 'delete.txt'), 'remove\n');
  const staged = await new FileSystemWorkspaceStager().prepare(root, 'echolens-00000000-0000-4000-8000-000000000001');
  context.after(() => staged.cleanup());
  await writeFile(join(staged.root, 'empty.txt'), 'generated\n');
  await unlink(join(staged.root, 'delete.txt'));
  await writeFile(join(staged.root, 'created.txt'), 'created\n');

  const bundle = await collectSandboxArtifacts({
    workspaceRoot: root,
    staged,
    id: 'echolens-00000000-0000-4000-8000-000000000001',
  });

  assert.equal(bundle.artifacts.length, 3);
  assert.deepEqual(bundle.patch?.operations.map((operation) => (operation as { op: string }).op).sort(), [
    'create', 'delete', 'overwrite',
  ]);
  const loaded = await loadSandboxArtifactBundle(root, bundle.id);
  const approvalPreview = await previewApprovalRequest({
    id: 'approval-1',
    toolName: 'apply_sandbox_patch',
    permission: 'workspace.write',
    arguments: { bundleId: bundle.id },
    argumentsHash: 'sha256:test',
    workspaceRoot: root,
    reasonCode: 'approval_required',
    reason: 'test',
    createdAt: new Date().toISOString(),
  });
  assert.deepEqual(approvalPreview?.changedFiles, ['created.txt', 'delete.txt', 'empty.txt']);
  assert.match(approvalPreview?.diff ?? '', /generated/u);
  await applyPatch(root, loaded.patch);
  assert.equal(await readFile(join(root, 'empty.txt'), 'utf8'), 'generated\n');
  assert.equal(await readFile(join(root, 'created.txt'), 'utf8'), 'created\n');
  await assert.rejects(readFile(join(root, 'delete.txt')));
});

test('Artifact 请求拒绝私有路径', async (context) => {
  // 攻击样本：请求方通过 requestedPaths 指定 .env.local，收集必须按私有路径拒绝，防止密钥被带出容器。
  const root = await mkdtemp(join(tmpdir(), 'echolens-artifacts-private-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const staged = await new FileSystemWorkspaceStager().prepare(root, 'echolens-00000000-0000-4000-8000-000000000002');
  context.after(() => staged.cleanup());
  await assert.rejects(collectSandboxArtifacts({
    workspaceRoot: root,
    staged,
    id: 'echolens-00000000-0000-4000-8000-000000000002',
    requestedPaths: ['.env.local'],
  }), (error: unknown) => error instanceof SandboxError && error.code === 'sandbox_artifact_failed');
});

test('Artifact 变化超过上限时失败关闭且不留下部分 Bundle', async (context) => {
  // 失败关闭：变化数超限时收集失败，且 bundle 根目录被删除，load 必须同样失败，验证不留半成品。
  const root = await mkdtemp(join(tmpdir(), 'echolens-artifacts-limit-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'one.txt'), 'before one\n');
  await writeFile(join(root, 'two.txt'), 'before two\n');
  const id = 'echolens-00000000-0000-4000-8000-000000000003';
  const staged = await new FileSystemWorkspaceStager().prepare(root, id);
  context.after(() => staged.cleanup());
  await writeFile(join(staged.root, 'one.txt'), 'after one\n');
  await writeFile(join(staged.root, 'two.txt'), 'after two\n');

  await assert.rejects(collectSandboxArtifacts({
    workspaceRoot: root,
    staged,
    id,
    maxChangedFiles: 1,
  }), (error: unknown) => error instanceof SandboxError && error.code === 'sandbox_artifact_failed');
  await assert.rejects(loadSandboxArtifactBundle(root, id));
});
