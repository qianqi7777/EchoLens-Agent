import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
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
  await applyPatch(root, loaded.patch);
  assert.equal(await readFile(join(root, 'empty.txt'), 'utf8'), 'generated\n');
  assert.equal(await readFile(join(root, 'created.txt'), 'utf8'), 'created\n');
  await assert.rejects(readFile(join(root, 'delete.txt')));
});

test('Artifact 请求拒绝私有路径', async (context) => {
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
