import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { buildChangeSet } from '../../../../src/runtime/change-set.js';
import { applyPatch, saveEditCheckpoint } from '../../../../src/runtime/structured-patch.js';
import { executeServiceCommand } from '../../../../src/commands/service-command.js';
import { SessionRuntime } from '../../../../src/session/session-runtime.js';

async function workspace(context: test.TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'echolens-change-set-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function applyAndSave(root: string, patch: Parameters<typeof applyPatch>[1]): Promise<string> {
  const result = await applyPatch(root, patch);
  return saveEditCheckpoint(root, result.checkpoint);
}

test('任务变更包按 checkpoint 字节合并多文件多轮改动', async (context) => {
  const root = await workspace(context);
  await writeFile(join(root, 'a.txt'), 'one\n');
  const first = await applyAndSave(root, {
    version: 1,
    operations: [
      { op: 'replace', path: 'a.txt', oldString: 'one', newString: 'two' },
      { op: 'create', path: 'new.txt', content: 'created\n' },
    ],
  });
  const aHash = createHash('sha256').update('two\n').digest('hex');
  const second = await applyAndSave(root, {
    version: 1,
    operations: [{ op: 'overwrite', path: 'a.txt', content: 'three\n', expectedFileHash: `sha256:${aHash}` }],
  });
  const set = await buildChangeSet(root, [first, second]);
  assert.deepEqual(set.files.map((file) => file.path), ['a.txt', 'new.txt']);
  assert.match(set.diff, /-one/u);
  assert.match(set.diff, /\+three/u);
  assert.match(set.diff, /\+created/u);
  assert.equal(set.files.find((file) => file.path === 'a.txt')?.beforeHash?.startsWith('sha256:'), true);
});

test('变更包记录删除/新增，且不受后续磁盘修改影响', async (context) => {
  const root = await workspace(context);
  await writeFile(join(root, 'remove.txt'), 'remove me\n');
  const hash = createHash('sha256').update('remove me\n').digest('hex');
  const checkpoint = await applyAndSave(root, {
    version: 1,
    operations: [{ op: 'delete', path: 'remove.txt', expectedFileHash: `sha256:${hash}` }],
  });
  await writeFile(join(root, 'remove.txt'), 'user changed after task\n');
  const set = await buildChangeSet(root, [checkpoint]);
  const file = set.files[0]!;
  assert.equal(file.beforeExisted, true);
  assert.equal(file.afterExisted, false);
  assert.match(file.diff, /-remove me/u);
  assert.doesNotMatch(file.diff, /user changed/u);
});

test('变更包拒绝损坏内容与不连续 checkpoint 链', async (context) => {
  const root = await workspace(context);
  await writeFile(join(root, 'a.txt'), 'one\n');
  const first = await applyAndSave(root, {
    version: 1, operations: [{ op: 'replace', path: 'a.txt', oldString: 'one', newString: 'two' }],
  });
  const second = await applyAndSave(root, {
    version: 1, operations: [{ op: 'replace', path: 'a.txt', oldString: 'two', newString: 'three' }],
  });
  const secondCheckpoint = await import('../../../../src/runtime/structured-patch.js').then(({ loadEditCheckpoint }) => loadEditCheckpoint(root, second));
  secondCheckpoint.files[0]!.contentBase64 = Buffer.from('wrong\n').toString('base64');
  const corrupt = await saveEditCheckpoint(root, secondCheckpoint);
  await assert.rejects(buildChangeSet(root, [first, corrupt]), /内容哈希不匹配/u);

  const thirdCheckpoint = await import('../../../../src/runtime/structured-patch.js').then(({ loadEditCheckpoint }) => loadEditCheckpoint(root, second));
  thirdCheckpoint.files[0]!.contentBase64 = Buffer.from('unrelated\n').toString('base64');
  thirdCheckpoint.files[0]!.hash = `sha256:${createHash('sha256').update('unrelated\n').digest('hex')}`;
  const broken = await saveEditCheckpoint(root, thirdCheckpoint);
  await assert.rejects(buildChangeSet(root, [first, broken]), /checkpoint 链不连续/u);
});

test('/diff 服务命令返回结构化变更包，支持有界截断与按文件重建', async (context) => {
  const root = await workspace(context);
  await writeFile(join(root, 'a.txt'), `${'before '.repeat(40)}\n`);
  const checkpoint = await applyAndSave(root, {
    version: 1, operations: [{ op: 'replace', path: 'a.txt', oldString: 'before '.repeat(40), newString: 'after '.repeat(40) }],
  });
  const result = await executeServiceCommand('/diff', {
    listSessions: async () => [], verify: async () => [],
    rollback: async () => ({ restoredPaths: [], skippedPaths: [] }),
    loadCheckpoint: async () => { throw new Error('unused'); },
    diff: async () => buildChangeSet(root, [checkpoint], { maxChars: 128 }),
  }, { currentSessionId: 's', confirm: async () => false });
  assert.ok(result.changeSet);
  assert.equal(result.changeSet?.truncated, true);
  assert.match(result.lines[0] ?? '', /变更包/u);
  const fileSet = await buildChangeSet(root, [checkpoint], { file: 'a.txt' });
  assert.equal(fileSet.files.length, 1);
  assert.match(fileSet.diff, /after/u);
  await assert.rejects(buildChangeSet(root, [checkpoint], { file: 'missing.txt' }), /没有文件/u);
  assert.equal(await readFile(join(root, 'a.txt'), 'utf8'), `${'after '.repeat(40)}\n`);
});

test('持久化 change.set.completed 后重开 Session 仍可按 Turn 追溯变更包', async (context) => {
  const root = await workspace(context);
  await writeFile(join(root, 'trace.txt'), 'before\n');
  const checkpoint = await applyAndSave(root, {
    version: 1, operations: [{ op: 'replace', path: 'trace.txt', oldString: 'before', newString: 'after' }],
  });
  const sessionRoot = join(root, 'sessions');
  const fakeAgent = {} as import('../../../../src/runtime/resumable-react-agent.js').ReactAgent;
  const first = await SessionRuntime.open(fakeAgent, { rootDirectory: sessionRoot, workspaceRoot: root, sessionId: 'trace-session' });
  await first.store.append({
    turnId: 'turn-trace',
    runId: 'run-trace',
    payload: { type: 'change.set.completed', files: ['trace.txt'], checkpointIds: [checkpoint], verification: { status: 'passed', issueCount: 0 } },
  });
  const beforeClose = await first.changeSet('turn-trace');
  assert.equal(beforeClose?.turnId, 'turn-trace');
  await first.close();
  const reopened = await SessionRuntime.open(fakeAgent, { rootDirectory: sessionRoot, workspaceRoot: root, sessionId: 'trace-session' });
  const afterReopen = await reopened.changeSet('turn-trace');
  assert.equal(afterReopen?.checkpointIds[0], checkpoint);
  assert.match(afterReopen?.diff ?? '', /\+after/u);
  assert.deepEqual(afterReopen?.verification, { status: 'passed', issueCount: 0 });
  await reopened.close();
});
