import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import {
  applyPatch,
  type EditCheckpoint,
  loadEditCheckpoint,
  restoreFiles,
  rollbackCheckpoint,
  rollbackTo,
  saveEditCheckpoint,
} from '../../../../src/runtime/structured-patch.js';

async function workspace(context: test.TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'echolens-rollback-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function applyAndLoad(root: string, patch: Parameters<typeof applyPatch>[1]) {
  const applied = await applyPatch(root, patch);
  const id = await saveEditCheckpoint(root, applied.checkpoint);
  return { id, checkpoint: await loadEditCheckpoint(root, id) };
}

test('restoreFiles 只恢复选中的文件，其余文件保持现状', async (context) => {
  const root = await workspace(context);
  await writeFile(join(root, 'a.txt'), 'a0\n');
  await writeFile(join(root, 'b.txt'), 'b0\n');
  const change = await applyAndLoad(root, {
    version: 1,
    operations: [
      { op: 'replace', path: 'a.txt', oldString: 'a0', newString: 'a1' },
      { op: 'replace', path: 'b.txt', oldString: 'b0', newString: 'b1' },
    ],
  });
  const result = await restoreFiles(change.checkpoint, ['a.txt']);
  assert.deepEqual(result.restoredPaths, ['a.txt']);
  assert.equal(await readFile(join(root, 'a.txt'), 'utf8'), 'a0\n');
  assert.equal(await readFile(join(root, 'b.txt'), 'utf8'), 'b1\n');
  await assert.rejects(restoreFiles(change.checkpoint, ['missing.txt']), /不包含文件/u);
  await assert.rejects(restoreFiles(change.checkpoint, ['../outside.txt']), /路径|relative|越界/u);
});

test('rollbackTo 按逆序回退多步并保留目标检查点状态', async (context) => {
  const root = await workspace(context);
  await writeFile(join(root, 'version.txt'), 'v0\n');
  const checkpoints = [];
  for (const [from, to] of [['v0', 'v1'], ['v1', 'v2'], ['v2', 'v3']] as const) {
    checkpoints.push((await applyAndLoad(root, {
      version: 1,
      operations: [{ op: 'replace', path: 'version.txt', oldString: from, newString: to }],
    })).checkpoint);
  }
  const result = await rollbackTo(checkpoints, 0);
  assert.deepEqual(result.completedCheckpointIds, checkpoints.slice(1).reverse().map((checkpoint) => {
    // saveEditCheckpoint IDs are deterministic hashes of the serialized checkpoint.
    return requireCheckpointId(checkpoint);
  }));
  assert.equal(await readFile(join(root, 'version.txt'), 'utf8'), 'v1\n');
});

test('多步回滚遇到用户后续修改时跳过受保护文件而不覆盖', async (context) => {
  const root = await workspace(context);
  await writeFile(join(root, 'guarded.txt'), 'v0\n');
  const first = await applyAndLoad(root, { version: 1, operations: [{ op: 'replace', path: 'guarded.txt', oldString: 'v0', newString: 'v1' }] });
  const second = await applyAndLoad(root, { version: 1, operations: [{ op: 'replace', path: 'guarded.txt', oldString: 'v1', newString: 'v2' }] });
  await writeFile(join(root, 'guarded.txt'), 'user-edit\n');
  const result = await rollbackCheckpoint(second.checkpoint);
  assert.deepEqual(result.skippedPaths, ['guarded.txt']);
  assert.equal(await readFile(join(root, 'guarded.txt'), 'utf8'), 'user-edit\n');
  assert.equal(first.id.length, 24);
});

function requireCheckpointId(checkpoint: EditCheckpoint): string {
  // The public API returns the IDs used by saveEditCheckpoint; this helper only
  // avoids duplicating filesystem access in the assertion.
  const serialized = JSON.stringify(checkpoint);
  return createDeterministicId(serialized);
}

import { createHash } from 'node:crypto';
function createDeterministicId(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 24);
}
