import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ToolRegistry } from '../../../../src/runtime/tool-registry.js';
import { registerUnifiedDiffTool, parseUnifiedDiff } from '../../../../src/runtime/unified-diff.js';

const ctx = (root: string) => ({ workspaceRoot: root, allowedPermissions: new Set(['workspace.write' as const]), signal: new AbortController().signal });

test('Unified diff 转结构化 Patch 并应用多文件、新建与删除', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'echolens-unified-diff-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'edit.txt'), 'one\ntwo\n', 'utf8');
  const diff = [
    '--- a/edit.txt', '+++ b/edit.txt', '@@ -1,2 +1,2 @@', ' one', '-two', '+three',
    '--- /dev/null', '+++ b/new.txt', '@@ -0,0 +1 @@', '+created',
  ].join('\n') + '\n';
  const patch = await parseUnifiedDiff(diff, root);
  assert.equal(patch.operations.length, 2);
  const registry = new ToolRegistry(); registerUnifiedDiffTool(registry);
  const result = await registry.get('apply_unified_diff').execute({ diff }, ctx(root));
  assert.equal(result.status, 'ok');
  assert.equal(await readFile(join(root, 'edit.txt'), 'utf8'), 'one\nthree\n');
  assert.equal(await readFile(join(root, 'new.txt'), 'utf8'), 'created\n');
});

test('Unified diff 上下文不匹配时拒绝且不写入', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'echolens-unified-diff-reject-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'edit.txt'), 'actual\n', 'utf8');
  const diff = '--- a/edit.txt\n+++ b/edit.txt\n@@ -1 +1 @@\n-expected\n+changed\n';
  const registry = new ToolRegistry(); registerUnifiedDiffTool(registry);
  const result = await registry.get('apply_unified_diff').execute({ diff }, ctx(root));
  assert.notEqual(result.status, 'ok');
  assert.equal(await readFile(join(root, 'edit.txt'), 'utf8'), 'actual\n');
});

test('Unified diff 删除文件仍复用结构化 Patch 管线', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'echolens-unified-delete-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'delete.txt'), 'gone\n', 'utf8');
  const diff = '--- a/delete.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-gone\n';
  const patch = await parseUnifiedDiff(diff, root);
  assert.equal(patch.operations[0]?.op, 'delete');
  const registry = new ToolRegistry(); registerUnifiedDiffTool(registry);
  const result = await registry.get('apply_unified_diff').execute({ diff }, ctx(root));
  assert.equal(result.status, 'ok');
  await assert.rejects(readFile(join(root, 'delete.txt'), 'utf8'));
});
