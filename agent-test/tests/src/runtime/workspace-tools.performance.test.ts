import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import test from 'node:test';
import { ToolExecutor } from '../../../../src/runtime/tool-executor.js';
import { ToolRegistry } from '../../../../src/runtime/tool-registry.js';
import { registerWorkspaceTools } from '../../../../src/runtime/workspace-tools.js';

const fileCount = 2_500;
const perOperationLimitMs = 20_000;

test('read-only workspace tools remain useful on a repository with thousands of files', {
  timeout: 60_000,
}, async (context) => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'echolens-performance-'));
  context.after(async () => rm(workspace, { recursive: true, force: true }));

  // 构造 2500 文件 / 50 目录的仓库，保证 list/grep 触发完整树形扫描而非单目录 IO；
  // 下方操作均选取字母序最后的文件（value2499 / file-2499.ts）作为最坏情况输入。
  const filesPerDirectory = 50;
  for (let directoryIndex = 0; directoryIndex < fileCount / filesPerDirectory; directoryIndex += 1) {
    const directory = path.join(workspace, `module-${directoryIndex.toString().padStart(2, '0')}`);
    await mkdir(directory);
    await Promise.all(Array.from({ length: filesPerDirectory }, async (_, fileIndex) => {
      const index = directoryIndex * filesPerDirectory + fileIndex;
      await writeFile(
        path.join(directory, `file-${index.toString().padStart(4, '0')}.ts`),
        `export const value${index} = ${index};\n`,
      );
    }));
  }

  const registry = new ToolRegistry();
  registerWorkspaceTools(registry);
  const executor = new ToolExecutor(registry, { timeoutMs: perOperationLimitMs });
  const toolContext = {
    workspaceRoot: workspace,
    allowedPermissions: new Set<'workspace.read'>(['workspace.read']),
    signal: new AbortController().signal,
  };

  const list = await timedInvoke(executor, 'list_files', {}, toolContext);
  assert.equal(list.result.status, 'ok');
  assert.match(list.result.content, /module-\d+\/file-\d+\.ts/u);
  assert.equal(list.result.outputMetadata?.truncated, false);
  assert.ok(list.elapsedMs < perOperationLimitMs, `list_files took ${list.elapsedMs.toFixed(0)}ms`);

  const grep = await timedInvoke(executor, 'grep', { pattern: 'value2499' }, toolContext);
  assert.equal(grep.result.status, 'ok');
  assert.match(grep.result.content, /file-2499\.ts:1:/u);
  assert.ok(grep.elapsedMs < perOperationLimitMs, `grep took ${grep.elapsedMs.toFixed(0)}ms`);

  const read = await timedInvoke(
    executor,
    'read_file',
    { path: 'module-49/file-2499.ts', start: 1, end: 1 },
    toolContext,
  );
  assert.equal(read.result.status, 'ok');
  assert.equal(read.result.content, '1: export const value2499 = 2499;');
  assert.ok(read.elapsedMs < perOperationLimitMs, `read_file took ${read.elapsedMs.toFixed(0)}ms`);
});

async function timedInvoke(
  executor: ToolExecutor,
  name: string,
  args: Record<string, unknown>,
  context: {
    workspaceRoot: string;
    allowedPermissions: ReadonlySet<'workspace.read'>;
    signal: AbortSignal;
  },
) {
  const startedAt = performance.now();
  const result = await executor.invoke(name, args, context);
  return { result, elapsedMs: performance.now() - startedAt };
}
