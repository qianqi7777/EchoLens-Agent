import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { previewApprovalRequest } from '../../../../src/approval-preview.js';
import { applyPatch } from '../../../../src/runtime/structured-patch.js';
import { collectSandboxArtifacts, loadSandboxArtifactBundle } from '../../../../src/sandbox/artifact-store.js';
import { SandboxError } from '../../../../src/sandbox/types.js';
import { FileSystemWorkspaceStager } from '../../../../src/sandbox/workspace-stager.js';

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

test('Artifact 将二进制变化与未变更请求文件分开保存并验证 Bundle 身份', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'echolens-artifacts-requested-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'report.txt'), 'unchanged report\n');
  await writeFile(join(root, 'image.png'), Buffer.from([0xff, 0xfe]));
  const id = 'echolens-00000000-0000-4000-8000-000000000004';
  const staged = await new FileSystemWorkspaceStager().prepare(root, id);
  context.after(() => staged.cleanup());
  await writeFile(join(staged.root, 'image.png'), Buffer.from([0xff, 0xfd, 0xfc]));

  const bundle = await collectSandboxArtifacts({
    workspaceRoot: root, staged, id, requestedPaths: ['./report.txt', 'report.txt'],
  });
  assert.deepEqual(bundle.artifacts.map((item) => [item.path, item.kind]), [
    ['image.png', 'workspace-change'], ['report.txt', 'requested'],
  ]);
  assert.equal(bundle.artifacts[0]?.mediaType, 'image/png');
  assert.equal(bundle.patch, undefined);
  assert.equal(bundle.warnings.some((warning) => warning.includes('二进制变化')), true);
  assert.equal((await loadSandboxArtifactBundle(root, bundle.id)).id, bundle.id);

  await writeFile(join(root, '.echolens', 'artifacts', bundle.id, 'manifest.json'), JSON.stringify({ ...bundle, workspaceRoot: 'wrong-root' }));
  await assert.rejects(loadSandboxArtifactBundle(root, bundle.id), (error: unknown) => error instanceof SandboxError && error.code === 'sandbox_artifact_failed');
});

test('Artifact 请求路径数量与总字节上限失败关闭', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'echolens-artifacts-request-limits-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'report.txt'), 'report');
  const id = 'echolens-00000000-0000-4000-8000-000000000005';
  const staged = await new FileSystemWorkspaceStager().prepare(root, id);
  context.after(() => staged.cleanup());
  await assert.rejects(collectSandboxArtifacts({
    workspaceRoot: root, staged, id, requestedPaths: Array.from({ length: 33 }, () => 'report.txt'),
  }), (error: unknown) => error instanceof SandboxError && error.code === 'sandbox_invalid_request');
  await assert.rejects(collectSandboxArtifacts({
    workspaceRoot: root, staged, id, requestedPaths: ['report.txt'], maxArtifactBytes: 3,
  }), (error: unknown) => error instanceof SandboxError && error.code === 'sandbox_artifact_failed');
  await assert.rejects(loadSandboxArtifactBundle(root, id));
});
