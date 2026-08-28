import assert from 'node:assert/strict';
import test from 'node:test';
import { runVerification, selectVerificationPlan } from './verification.js';

test('Verification 结果区分 passed/failed/skipped/timeout', async () => {
  const plan = { reason: 'test', commands: [
    { id: 'a', label: 'a', command: 'a', executable: 'a', args: [], required: true },
    { id: 'b', label: 'b', command: 'b', executable: 'b', args: [] },
  ] as const };
  const results = await runVerification(plan, { runCommand: async (command) => ({
    id: command.id, label: command.label, command: command.command,
    status: command.id === 'a' ? 'failed' : 'passed', durationMs: 1, summary: command.id === 'a' ? '失败' : '通过',
  }) });
  assert.deepEqual(results.map((result) => result.status), ['failed', 'skipped']);
  const timeout = await runVerification({ reason: 'test', commands: [{ id: 't', label: 't', command: 't', executable: 't', args: [] }] }, {
    runCommand: async (command) => ({ id: command.id, label: command.label, command: command.command, status: 'timeout', durationMs: 10, summary: '超时' }),
  });
  assert.equal(timeout[0]?.status, 'timeout');
});

test('Verification 根据 TypeScript 改动选择类型检查', async (context) => {
  const root = context.name ? process.cwd() : process.cwd();
  const plan = await selectVerificationPlan(root, ['src/example.ts']);
  const command = plan.commands.find((item) => item.id === 'typecheck');
  assert.ok(command);
  assert.equal(command.command, 'npm run typecheck');
  assert.deepEqual(command.args, ['run', 'typecheck']);
});
