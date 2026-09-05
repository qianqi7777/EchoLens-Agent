import assert from 'node:assert/strict';
import test from 'node:test';
import {
  completeCommand,
  filterCommandCandidates,
  formatCommandHelp,
} from '../../../../src/commands/command-catalog.js';

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
