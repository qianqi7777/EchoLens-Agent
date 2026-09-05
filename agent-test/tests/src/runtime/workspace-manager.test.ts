import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  executeWorkspaceCommand,
  resolveWorkspaceDirectory,
  WorkspaceRuntimeManager,
  WorkspaceSwitchError,
  type ManagedWorkspaceRuntime,
} from '../../../../src/runtime/workspace-manager.js';

test('工作目录命令支持查看、相对路径和带空格路径', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'echolens-workspace-command-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const first = join(root, 'first workspace');
  const second = join(root, 'second workspace');
  await Promise.all([mkdir(first), mkdir(second)]);
  const runtimes: FakeRuntime[] = [];
  const initial = runtime(await resolveWorkspaceDirectory(first, root), 'session-first');
  runtimes.push(initial);
  const manager = new WorkspaceRuntimeManager(initial, async (workspaceRoot) => {
    const next = runtime(workspaceRoot, 'session-second');
    runtimes.push(next);
    return next;
  });

  const current = await executeWorkspaceCommand('/pwd', manager);
  assert.equal(current.handled, true);
  assert.match(current.lines[0] ?? '', /first workspace/u);

  const switched = await executeWorkspaceCommand('/cd "../second workspace"', manager);
  assert.equal(switched.workspace?.changed, true);
  assert.equal(switched.workspace?.workspaceRoot, await resolveWorkspaceDirectory(second, root));
  assert.equal(switched.workspace?.sessionId, 'session-second');
  assert.equal(initial.closed, true);
  assert.equal(runtimes.length, 2);

  const unchanged = await executeWorkspaceCommand(`/workspace "${second}"`, manager);
  assert.equal(unchanged.workspace?.changed, false);
  assert.equal(runtimes.length, 2);
  await manager.close();
  assert.equal(runtimes[1]?.closed, true);
});

test('新工作区初始化失败时保留旧运行时', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'echolens-workspace-atomic-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const first = join(root, 'first');
  const second = join(root, 'second');
  await Promise.all([mkdir(first), mkdir(second)]);
  const initial = runtime(await resolveWorkspaceDirectory(first, root), 'session-first');
  const manager = new WorkspaceRuntimeManager(initial, async () => {
    throw new Error('extension startup failed');
  });

  await assert.rejects(
    manager.switchWorkspace(second),
    (error: unknown) => error instanceof WorkspaceSwitchError
      && error.code === 'workspace_open_failed'
      && /extension startup failed/u.test(error.message),
  );
  assert.equal(manager.currentRuntime(), initial);
  assert.equal(initial.closed, false);
  await manager.close();
});

test('并发切换按顺序关闭中间运行时', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'echolens-workspace-serial-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const directories = [join(root, 'one'), join(root, 'two'), join(root, 'three')];
  await Promise.all(directories.map((directory) => mkdir(directory)));
  const initial = runtime(await resolveWorkspaceDirectory(directories[0]!, root), 'session-one');
  const created: FakeRuntime[] = [initial];
  const manager = new WorkspaceRuntimeManager(initial, async (workspaceRoot) => {
    const next = runtime(workspaceRoot, `session-${created.length + 1}`);
    created.push(next);
    return next;
  });

  const [second, third] = await Promise.all([
    manager.switchWorkspace(directories[1]!),
    manager.switchWorkspace(directories[2]!),
  ]);

  assert.equal(second.sessionId, 'session-2');
  assert.equal(third.sessionId, 'session-3');
  assert.equal(initial.closed, true);
  assert.equal(created[1]?.closed, true);
  assert.equal(created[2]?.closed, false);
  assert.equal(manager.current().workspaceRoot, await resolveWorkspaceDirectory(directories[2]!, root));
  await manager.close();
});

test('工作目录解析拒绝缺失路径和普通文件', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'echolens-workspace-validation-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, 'file.txt');
  await writeFile(file, 'not a directory\n');

  await assert.rejects(
    resolveWorkspaceDirectory(join(root, 'missing'), root),
    (error: unknown) => error instanceof WorkspaceSwitchError && error.code === 'workspace_not_found',
  );
  await assert.rejects(
    resolveWorkspaceDirectory(file, root),
    (error: unknown) => error instanceof WorkspaceSwitchError && error.code === 'workspace_not_directory',
  );
});

interface FakeRuntime extends ManagedWorkspaceRuntime {
  closed: boolean;
}

function runtime(workspaceRoot: string, sessionId: string): FakeRuntime {
  return {
    workspaceRoot,
    sessionId,
    closed: false,
    async close() {
      this.closed = true;
    },
  };
}
