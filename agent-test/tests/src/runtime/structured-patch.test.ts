import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  applyPatch,
  listEditCheckpoints,
  listEditCheckpointIds,
  loadEditCheckpoint,
  normalizePatch,
  PatchError,
  previewPatch,
  restoreFiles,
  rollbackCheckpoint,
  rollbackTo,
  saveEditCheckpoint,
} from '../../../../src/runtime/structured-patch.js';

async function workspace(context: test.TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'echolens-patch-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('结构化 Patch 保留 BOM/CRLF 并生成可审查 diff', async (context) => {
  const root = await workspace(context);
  // Fixture \u6545\u610f\u8fdd\u53cd\u7eaf LF \u6587\u672c\u7ea6\u5b9a\uff1a\u6587\u4ef6\u5e26 UTF-8 BOM \u4e14\u4f7f\u7528 CRLF \u6362\u884c\uff0c
  // \u8986\u76d6 Windows \u5e38\u89c1\u6587\u672c\u683c\u5f0f\uff1boldString \u4ee5 LF \u5339\u914d\u987b\u5bb9\u5fcd CRLF\uff0creplace \u540e BOM/CRLF \u5fc5\u987b\u4fdd\u7559\u3002
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
  // 失败关闭：上下文零匹配/多匹配时直接报错，不猜测替换目标；哈希漂移与
  // create 命中已存在目标同理拒绝，防止静默覆盖并发产生的用户数据。
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

test('Patch schema validation rejects malformed operations and configured limits', async () => {
  const invalidCases: unknown[] = [
    undefined,
    { version: 2, operations: [] },
    { version: 1, operations: [] },
    { version: 1, operations: [{ op: 'replace', path: 'a.txt' }] },
    { version: 1, operations: [{ op: 'overwrite', path: 'a.txt', content: 'x' }] },
    { version: 1, operations: [{ op: 'delete', path: 'a.txt' }] },
    { version: 1, operations: [{ op: 'unknown', path: 'a.txt' }] },
    { version: 1, operations: [{ op: 'create', path: '../outside.txt', content: 'x' }] },
    { version: 1, operations: [{ op: 'create', path: 'a.txt', content: 'x' }, { op: 'create', path: './a.txt', content: 'y' }] },
  ];
  for (const value of invalidCases) assert.throws(() => normalizePatch(value));
  assert.throws(() => normalizePatch({ version: 1, operations: [{ op: 'create', path: 'a.txt', content: 'x' }, { op: 'create', path: 'b.txt', content: 'y' }] }, { maxFiles: 1 }), /文件数/u);
  assert.throws(() => normalizePatch({ version: 1, operations: [{ op: 'create', path: 'a.txt', content: 'x' }] }, { maxOperations: 0 }), /操作数/u);
});

test('Patch persists checkpoints, enforces context, and rejects binary text', async (context) => {
  const root = await workspace(context);
  await writeFile(join(root, 'file.txt'), 'before\nanchor\nafter\n');
  const applied = await applyPatch(root, {
    version: 1,
    operations: [{ op: 'replace', path: 'file.txt', oldString: 'anchor', newString: 'changed', expectedContext: { before: 'before\n', after: '\nafter' } }],
  });
  const checkpointId = await saveEditCheckpoint(root, applied.checkpoint);
  assert.equal((await listEditCheckpointIds(root)).includes(checkpointId), true);
  assert.equal((await loadEditCheckpoint(root, checkpointId)).workspaceRoot, applied.checkpoint.workspaceRoot);
  await writeFile(join(root, 'file.txt'), 'user\n');
  await assert.rejects(restoreFiles(root, checkpointId, []), (error) => error instanceof PatchError && error.code === 'patch_invalid');
  await assert.rejects(restoreFiles(root, checkpointId, ['unknown.txt']), (error) => error instanceof PatchError && error.code === 'patch_invalid');

  await assert.rejects(previewPatch(root, {
    version: 1,
    operations: [{ op: 'replace', path: 'file.txt', oldString: 'user', newString: 'x', expectedContext: { before: 'wrong' } }],
  }), (error) => error instanceof PatchError && error.code === 'patch_context_mismatch');

  await writeFile(join(root, 'binary.bin'), Buffer.from([0xff, 0xfe, 0xfd]));
  await assert.rejects(previewPatch(root, {
    version: 1,
    operations: [{ op: 'replace', path: 'binary.bin', oldString: 'x', newString: 'y' }],
  }), (error) => error instanceof PatchError && error.code === 'patch_binary_unsupported');
});

test('Patch checkpoint listing and indexed rollback only undo later Agent changes', async (context) => {
  const root = await workspace(context);
  assert.deepEqual(await listEditCheckpoints(root), []);
  await writeFile(join(root, 'file.txt'), 'initial\n');
  const first = await applyPatch(root, {
    version: 1, operations: [{ op: 'replace', path: 'file.txt', oldString: 'initial', newString: 'middle' }],
  });
  const firstId = await saveEditCheckpoint(root, first.checkpoint);
  const second = await applyPatch(root, {
    version: 1, operations: [{ op: 'replace', path: 'file.txt', oldString: 'middle', newString: 'agent' }],
  });
  const secondId = await saveEditCheckpoint(root, second.checkpoint);
  assert.deepEqual(await listEditCheckpointIds(root), [firstId, secondId]);
  await assert.rejects(rollbackTo([first.checkpoint, second.checkpoint], -1), (error) => error instanceof PatchError && error.code === 'patch_invalid');
  const undone = await rollbackTo(root, [firstId, secondId], 0);
  assert.deepEqual(undone.completedCheckpointIds, [secondId]);
  assert.deepEqual(undone.restoredPaths, ['file.txt']);
  assert.equal(await readFile(join(root, 'file.txt'), 'utf8'), 'middle\n');
});

test('Patch rollback deletes unchanged creations but preserves later user edits', async (context) => {
  const root = await workspace(context);
  const created = await applyPatch(root, {
    version: 1, operations: [{ op: 'create', path: 'new.txt', content: 'agent\n' }],
  });
  const deleted = await rollbackCheckpoint(created.checkpoint);
  assert.deepEqual(deleted.restoredPaths, ['new.txt']);
  assert.equal(await readFile(join(root, 'new.txt')).catch(() => undefined), undefined);

  const createdAgain = await applyPatch(root, {
    version: 1, operations: [{ op: 'create', path: 'new.txt', content: 'agent\n' }],
  });
  await writeFile(join(root, 'new.txt'), 'user\n');
  const preserved = await rollbackCheckpoint(createdAgain.checkpoint);
  assert.deepEqual(preserved.skippedPaths, ['new.txt']);
  assert.equal(await readFile(join(root, 'new.txt'), 'utf8'), 'user\n');
});

test('Patch 拒绝后置上下文漂移与预览规模越界，且不写入文件', async (context) => {
  const root = await workspace(context);
  await writeFile(join(root, 'note.txt'), 'before\nanchor\nafter\n');
  const patch = { version: 1, operations: [{ op: 'replace', path: 'note.txt', oldString: 'anchor', newString: 'much-longer-change' }] };
  await assert.rejects(previewPatch(root, {
    version: 1,
    operations: [{ ...patch.operations[0], expectedContext: { after: '\nmissing' } }],
  }), (error: unknown) => error instanceof PatchError && error.code === 'patch_context_mismatch');
  await assert.rejects(previewPatch(root, patch, { maxChangedBytes: 1 }),
    (error: unknown) => error instanceof PatchError && error.code === 'patch_limits_exceeded');
  await assert.rejects(previewPatch(root, patch, { maxChangedLines: 0 }),
    (error: unknown) => error instanceof PatchError && error.code === 'patch_limits_exceeded');
  assert.equal(await readFile(join(root, 'note.txt'), 'utf8'), 'before\nanchor\nafter\n');
});

test('Checkpoint 拒绝跨工作区移植；回滚不复活已移除的新文件或覆盖用户重建文件', async (context) => {
  const root = await workspace(context);
  const otherRoot = await workspace(context);
  const created = await applyPatch(root, {
    version: 1, operations: [{ op: 'create', path: 'new.txt', content: 'agent\n' }],
  });
  const foreignId = await saveEditCheckpoint(root, { ...created.checkpoint, workspaceRoot: otherRoot });
  await assert.rejects(loadEditCheckpoint(root, foreignId),
    (error: unknown) => error instanceof PatchError && error.code === 'patch_invalid');
  await rm(join(root, 'new.txt'));
  assert.deepEqual(await rollbackCheckpoint(created.checkpoint), { restoredPaths: [], skippedPaths: [] });

  await writeFile(join(root, 'old.txt'), 'before\n');
  const deleted = await applyPatch(root, {
    version: 1,
    operations: [{ op: 'delete', path: 'old.txt', expectedFileHash: `sha256:${createHash('sha256').update('before\n').digest('hex')}` }],
  });
  await writeFile(join(root, 'old.txt'), 'user recreated\n');
  const rollback = await rollbackCheckpoint(deleted.checkpoint);
  assert.deepEqual(rollback.skippedPaths, ['old.txt']);
  assert.equal(await readFile(join(root, 'old.txt'), 'utf8'), 'user recreated\n');

  await rm(join(root, 'old.txt'));
  const restored = await rollbackCheckpoint(deleted.checkpoint);
  assert.deepEqual(restored.restoredPaths, ['old.txt']);
  assert.equal(await readFile(join(root, 'old.txt'), 'utf8'), 'before\n');
});

test('旧检查点缺少应用后证据时不覆盖或删除现有用户文件', async (context) => {
  const root = await workspace(context);
  await writeFile(join(root, 'existing.txt'), 'user edited\n');
  await writeFile(join(root, 'created.txt'), 'user created\n');
  const checkpoint = {
    version: 1 as const,
    workspaceRoot: root,
    workspaceRevision: { value: 'legacy', capturedAt: new Date().toISOString(), fileCount: 2 },
    createdAt: new Date().toISOString(),
    files: [
      { path: 'existing.txt', existed: true, contentBase64: Buffer.from('old\n').toString('base64') },
      { path: 'created.txt', existed: false },
    ],
  };
  const result = await rollbackCheckpoint(checkpoint);
  assert.deepEqual(result.skippedPaths, ['existing.txt', 'created.txt']);
  assert.equal(await readFile(join(root, 'existing.txt'), 'utf8'), 'user edited\n');
  assert.equal(await readFile(join(root, 'created.txt'), 'utf8'), 'user created\n');
});
