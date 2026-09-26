import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ToolRegistry } from '../../../../src/runtime/tool-registry.js';
import { registerGitTools } from '../../../../src/runtime/git-tools.js';

const exec = promisify(execFile);
const context = (root: string) => ({ workspaceRoot: root, allowedPermissions: new Set(['workspace.read' as const]), signal: new AbortController().signal });

test('Git 只读工具读取状态、diff 与 log', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'echolens-git-tools-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await exec('git', ['init', '-q'], { cwd: root });
  await exec('git', ['config', 'user.email', 'test@example.invalid'], { cwd: root });
  await exec('git', ['config', 'user.name', 'Test'], { cwd: root });
  await writeFile(join(root, 'note.txt'), 'hello\n', 'utf8');
  await exec('git', ['add', 'note.txt'], { cwd: root });
  await exec('git', ['commit', '-qm', 'initial'], { cwd: root });
  await writeFile(join(root, 'note.txt'), 'hello changed\n', 'utf8');
  const registry = new ToolRegistry(); registerGitTools(registry);
  const status = await registry.get('git_status').execute({ porcelain: true }, context(root));
  assert.equal(status.status, 'ok'); assert.match(status.content, /note\.txt/u);
  const diff = await registry.get('git_diff').execute({ path: 'note.txt' }, context(root));
  assert.equal(diff.status, 'ok'); assert.match(diff.content, /hello changed/u);
  const log = await registry.get('git_log').execute({ maxCount: 1 }, context(root));
  assert.equal(log.status, 'ok');
});

test('Git 工具拒绝改变仓库根或执行外部程序的选项', async () => {
  const registry = new ToolRegistry(); registerGitTools(registry);
  const tool = registry.get('git_diff');
  const result = await tool.execute({ path: '--git-dir=outside' }, context(process.cwd()));
  assert.notEqual(result.status, 'ok');
  const log = registry.get('git_log');
  const rejected = await log.execute({ path: '../outside' }, context(process.cwd()));
  assert.notEqual(rejected.status, 'ok');
});
