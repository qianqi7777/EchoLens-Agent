import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { ContextManager } from '../../../../src/context/context-manager.js';
import { GitHistoryProvider, type GitHistoryEntry, type GitHistoryResult } from '../../../../src/navigation/git-history.js';

const run = promisify(execFile);

test('GitHistoryProvider 只读读取目标文件的有界提交摘要并拒绝越界路径', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'echolens-git-history-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  try {
    await run('git', ['init', root], { windowsHide: true });
  } catch {
    context.skip('当前环境没有可用 Git');
    return;
  }
  await run('git', ['-C', root, 'config', 'user.email', 'test@example.invalid']);
  await run('git', ['-C', root, 'config', 'user.name', 'EchoLens Test']);
  await writeFile(join(root, 'src.ts'), 'export const value = 1;\n');
  await run('git', ['-C', root, 'add', 'src.ts']);
  await run('git', ['-C', root, 'commit', '-m', 'initial source']);
  await writeFile(join(root, 'src.ts'), 'export const value = 2;\n');
  await run('git', ['-C', root, 'add', 'src.ts']);
  await run('git', ['-C', root, 'commit', '-m', 'update source']);
  const provider = new GitHistoryProvider(root);
  const result = await provider.load(['src.ts'], { limit: 1 });
  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0]?.path, 'src.ts');
  assert.match(result.entries[0]?.subject ?? '', /update source/u);
  assert.equal(result.truncated, true);
  await assert.rejects(provider.load(['../outside.ts']), /路径|relative|越界/u);
  await assert.rejects(provider.load(['.git']), /\.git/u);
});

test('metadata 隐私模式禁用 Git 历史，full-context 作为候选来源注入并计入报告', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'echolens-git-context-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  let calls = 0;
  const entry: GitHistoryEntry = { path: 'src.ts', hash: 'a'.repeat(40), authoredAt: '2026-01-01T00:00:00Z', author: 'test', subject: 'candidate change' };
  const provider = { load: async (): Promise<GitHistoryResult> => { calls += 1; return { entries: [entry], truncated: false, warnings: [] }; } } as unknown as GitHistoryProvider;
  const manager = new ContextManager({ workspaceRoot: root, gitHistory: provider });
  const metadata = await manager.build([{ type: 'message', id: 'user', role: 'user', content: [{ type: 'text', text: 'inspect' }] }], {
    privacy: 'metadata', providerMaxContextTokens: 8_192, runtimePermissions: new Set(), gitHistoryPaths: ['src.ts'],
  });
  assert.equal(calls, 0);
  assert.equal(metadata.sourceUsage.some((item) => item.source === 'git-history'), false);
  const full = await manager.build([{ type: 'message', id: 'user-2', role: 'user', content: [{ type: 'text', text: 'inspect' }] }], {
    privacy: 'full-context', providerMaxContextTokens: 8_192, runtimePermissions: new Set(), gitHistoryPaths: ['src.ts'],
  });
  assert.equal(calls, 1);
  assert.equal(full.sourceUsage.some((item) => item.source === 'git-history'), true);
  assert.match(JSON.stringify(full.items), /candidate change/u);
});
