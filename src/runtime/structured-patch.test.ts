import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { applyPatch, PatchError, previewPatch, rollbackCheckpoint } from './structured-patch.js';

async function workspace(context: test.TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'echolens-patch-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('结构化 Patch 保留 BOM/CRLF 并生成可审查 diff', async (context) => {
  const root = await workspace(context);
  await writeFile(join(root, 'note.txt'), Buffer.from('\ufeffone\r\ntwo\r\n', 'utf8'));
  const preview = await previewPatch(root, {
    version: 1,
    operations: [{ op: 'replace', path: 'note.txt', oldString: 'one\ntwo', newString: 'one\nchanged' }],
  });
  assert.equal(preview.files[0]?.linesAdded, 1);
  assert.match(preview.files[0]?.diff ?? '', /-two/);
  await applyPatch(root, {
    version: 1,
    operations: [{ op: 'replace', path: 'note.txt', oldString: 'one\ntwo', newString: 'one\nchanged' }],
  });
  const result = await readFile(join(root, 'note.txt'));
  assert.equal(result.toString('utf8'), '\ufeffone\r\nchanged\r\n');
});

test('Patch 对零匹配、多匹配、哈希漂移和已有 create 目标失败关闭', async (context) => {
  const root = await workspace(context);
  await writeFile(join(root, 'a.txt'), 'same\nsame\n');
  await assert.rejects(previewPatch(root, { version: 1, operations: [{ op: 'replace', path: 'a.txt', oldString: 'missing', newString: 'x' }] }), (error) => error instanceof PatchError && error.code === 'patch_context_mismatch');
  await assert.rejects(previewPatch(root, { version: 1, operations: [{ op: 'replace', path: 'a.txt', oldString: 'same', newString: 'x' }] }), (error) => error instanceof PatchError && error.code === 'patch_ambiguous');
  await assert.rejects(previewPatch(root, { version: 1, operations: [{ op: 'create', path: 'a.txt', content: 'x' }] }), (error) => error instanceof PatchError && error.code === 'patch_target_exists');
  const hash = 'sha256:' + '0'.repeat(64);
  await assert.rejects(previewPatch(root, { version: 1, operations: [{ op: 'delete', path: 'a.txt', expectedFileHash: hash }] }), (error) => error instanceof PatchError && error.code === 'patch_hash_mismatch');
});

test('Patch 支持 create/delete，并能回滚删除文件', async (context) => {
  const root = await workspace(context);
  await writeFile(join(root, 'old.txt'), 'old\n');
  const preview = await previewPatch(root, { version: 1, operations: [{ op: 'create', path: 'new.txt', content: 'new\n' }] });
  assert.equal(preview.changedFiles[0], 'new.txt');
  const applied = await applyPatch(root, { version: 1, operations: [{ op: 'create', path: 'new.txt', content: 'new\n' }] });
  assert.equal(await readFile(join(root, 'new.txt'), 'utf8'), 'new\n');
  await applyPatch(root, {
    version: 1,
    operations: [{ op: 'delete', path: 'old.txt', expectedFileHash: applied.afterSnapshot.files.find((file) => file.path === 'old.txt')?.hash ?? '' }],
  });
  assert.equal(await readFile(join(root, 'old.txt')).catch(() => undefined), undefined);
});

test('overwrite 使用原文件哈希安全地整体替换空文件', async (context) => {
  const root = await workspace(context);
  await writeFile(join(root, 'empty.txt'), '');
  const emptyHash = 'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
  const applied = await applyPatch(root, {
    version: 1,
    operations: [{ op: 'overwrite', path: 'empty.txt', content: 'generated\n', expectedFileHash: emptyHash }],
  });
  assert.equal(await readFile(join(root, 'empty.txt'), 'utf8'), 'generated\n');
  assert.equal(applied.preview.files[0]?.operation, 'overwrite');
});

test('回滚不会覆盖 Patch 完成后产生的用户修改', async (context) => {
  const root = await workspace(context);
  await writeFile(join(root, 'file.txt'), 'before\n');
  const applied = await applyPatch(root, { version: 1, operations: [{ op: 'replace', path: 'file.txt', oldString: 'before', newString: 'agent' }] });
  await writeFile(join(root, 'file.txt'), 'user-change\n');
  const rollback = await rollbackCheckpoint(applied.checkpoint);
  assert.deepEqual(rollback.skippedPaths, ['file.txt']);
  assert.equal(await readFile(join(root, 'file.txt'), 'utf8'), 'user-change\n');
});
