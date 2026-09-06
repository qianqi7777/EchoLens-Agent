import assert from 'node:assert/strict';
import test from 'node:test';
import {
  completeCommand,
  filterCommandCandidates,
  formatCommandHelp,
  getCommandCatalog,
  parseCommandInput,
  commandMenuWindow,
} from '../../../../src/commands/command-catalog.js';
import { completeArguments } from '../../../../src/commands/argument-completion.js';
import { executeSessionCommand } from '../../../../src/commands/session-command.js';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';

const context = { workspaceAvailable: true, backgroundTasksAvailable: true };

test('命令目录按名称和别名过滤，并保留稳定顺序', () => {
  assert.deepEqual(
    filterCommandCandidates('/', context).map((command) => command.name),
    ['/pwd', '/cd', '/resume', '/sessions', '/tasks', '/task', '/verify', '/rollback', '/steer', '/clear', '/help', '/exit'],
  );
  assert.equal(filterCommandCandidates('/wo', context)[0]?.name, '/cd');
  assert.equal(filterCommandCandidates('/wo', context)[0]?.aliases?.[0], '/workspace');
});

test('参数命令补全保留用户输入的别名并追加空格', () => {
  const command = filterCommandCandidates('/wo', context)[0]!;
  assert.equal(completeCommand('/wo', command), '/workspace ');
  assert.equal(completeCommand('/cd', command), '/cd ');
});

test('命令帮助与目录共享描述和用法', () => {
  const help = formatCommandHelp(context);
  assert.ok(help.some((line) => line.startsWith('/cd <path>：查看或切换工作目录')));
  assert.ok(help.some((line) => line.startsWith('/exit：退出当前 Agent 进程')));
});

test('主名称优先，别名、界面和依赖能力独立处理', () => {
  for (const name of ['/cd', '/exit']) {
    const command = getCommandCatalog(context).find((item) => item.name === name)!;
    assert.equal(completeCommand('/', command), name + (command.acceptsArguments ? ' ' : ''));
  }
  const names = getCommandCatalog({ ...context, workspaceAvailable: false, interface: 'line' }).map((item) => item.name);
  assert.ok(names.includes('/verify') && names.includes('/rollback'));
  assert.ok(!names.includes('/clear') && !names.includes('/cd'));
  assert.deepEqual(getCommandCatalog({ ...context, busy: true }).map((item) => item.name), ['/steer']);
  assert.ok(getCommandCatalog({ ...context, sessionDeletionAvailable: true }).some((item) => item.name === '/session'));
});

test('命令解析统一大小写和空白，拒绝错误命令及多余参数', () => {
  assert.equal(parseCommandInput('/WORKSPACE\t"My Project"', context).input, '/cd "My Project"');
  assert.equal(parseCommandInput('/workspace', context).input, '/pwd');
  assert.equal(parseCommandInput('/quit', context).input, '/exit');
  for (const input of ['/rollbackoops id', '/exit now', '/sessions extra', '/missing']) {
    assert.ok(parseCommandInput(input, context).error, input);
  }
  assert.ok(parseCommandInput('/clear', { ...context, interface: 'line' }).error);
});

test('任何候选索引均处于可视窗口内', () => {
  for (const capacity of [1, 6, 8]) for (let selected = 0; selected < 13; selected++) {
    const window = commandMenuWindow(13, selected, capacity);
    assert.ok(window.start <= selected && window.end > selected);
    assert.ok(window.end - window.start <= capacity);
  }
});

test('参数补全支持目录、任务、会话和检查点，仅读本地元数据', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'echolens-completion-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, '中文 space'));
  await mkdir(join(root, '.echolens', 'checkpoints'), { recursive: true });
  await writeFile(join(root, '.echolens', 'checkpoints', 'checkpoint-1.json'), '{}');
  await writeFile(join(root, 'not-directory'), '');
  const ctx = { workspaceRoot: root, currentSessionId: 'active',
    listSessions: async () => [{ sessionId: 'active' }, { sessionId: 'older' }],
    listTasks: async () => [{ id: 'task-1', state: 'paused' }],
  };
  assert.equal((await completeArguments('/cd 中', ctx))[0]?.replacement, `/cd "中文 space${sep}"`);
  assert.equal((await completeArguments('/cd "中文', ctx))[0]?.replacement, `/cd "中文 space${sep}"`);
  assert.equal((await completeArguments('/task ', ctx)).length, 5);
  assert.equal((await completeArguments('/task cancel ', ctx))[0]?.replacement, '/task cancel task-1 ');
  assert.deepEqual((await completeArguments('/session delete ', ctx)).map((item) => item.name), ['older']);
  assert.equal((await completeArguments('/rollback ', ctx))[0]?.replacement, '/rollback checkpoint-1 ');
  assert.deepEqual(await completeArguments('/cd nonexistent/', ctx), []);
});

test('会话删除必须确认，拒绝当前、未知和多余参数，列表不截断', async () => {
  const sessions = Array.from({ length: 25 }, (_, i) => ({ sessionId: `s${i}`, bytes: 1, modifiedAt: 'date' }));
  let confirmed = false;
  let calls = 0;
  const service = { currentSessionId: 's0', list: async () => sessions,
    confirm: async () => confirmed, delete: async () => { calls++; },
  };
  assert.equal((await executeSessionCommand('/sessions', service)).length, 25);
  assert.match((await executeSessionCommand('/sessions', service))[0]!, /当前/u);
  await executeSessionCommand('/session delete s24', service);
  assert.equal(calls, 0);
  confirmed = true;
  await executeSessionCommand('/session delete s24', service);
  assert.equal(calls, 1);
  await assert.rejects(executeSessionCommand('/session delete s0', service), /当前/u);
  await assert.rejects(executeSessionCommand('/session delete missing', service), /未找到/u);
  assert.match((await executeSessionCommand('/session delete s1 extra', service))[0]!, /用法/u);
  assert.equal(calls, 1);
});
