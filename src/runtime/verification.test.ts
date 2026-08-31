import assert from 'node:assert/strict';
import test from 'node:test';
import { runVerification, selectVerificationPlan } from './verification.js';

// 注入假 runCommand 而不是真的执行命令：验证的是计划选择与状态归约逻辑，不是命令本身。
test('Verification 结果区分 passed/failed/skipped/timeout', async () => {
  const plan = { reason: 'test', commands: [
    { id: 'a', label: 'a', command: 'a', executable: 'a', args: [], required: true },
    { id: 'b', label: 'b', command: 'b', executable: 'b', args: [] },
  ] as const };
  const results = await runVerification(plan, { runCommand: async (command) => ({
    id: command.id, label: command.label, command: command.command,
    status: command.id === 'a' ? 'failed' : 'passed', durationMs: 1, summary: command.id === 'a' ? '失败' : '通过',
  }) });
  // 必需命令 a 失败后 b 被标记 skipped：验证失败时不能继续执行可能产生副作用的后续命令。
  assert.deepEqual(results.map((result) => result.status), ['failed', 'skipped']);
  // timeout 必须原样透传：超时是“没跑完”，既不是通过也不是失败，UI 需要区分。
  const timeout = await runVerification({ reason: 'test', commands: [{ id: 't', label: 't', command: 't', executable: 't', args: [] }] }, {
    runCommand: async (command) => ({ id: command.id, label: command.label, command: command.command, status: 'timeout', durationMs: 10, summary: '超时' }),
  });
  assert.equal(timeout[0]?.status, 'timeout');
});

test('Verification 根据 TypeScript 改动选择类型检查', async (context) => {
  const root = context.name ? process.cwd() : process.cwd();
  const plan = await selectVerificationPlan(root, ['src/example.ts']);
  // .ts 改动必须触发 typecheck：这是编辑后校验对类型安全的兜底承诺。
  const command = plan.commands.find((item) => item.id === 'typecheck');
  assert.ok(command);
  assert.equal(command.command, 'npm run typecheck');
  assert.deepEqual(command.args, ['run', 'typecheck']);
});
