import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { parseVerificationGate, runVerification, selectVerificationPlan } from '../../../../src/runtime/verification.js';

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

test('Verification gate and plan selection fail closed for unsupported or missing scripts', async () => {
  assert.equal(parseVerificationGate(undefined), 'auto');
  assert.equal(parseVerificationGate('off'), 'off');
  assert.equal(parseVerificationGate('strict'), 'strict');
  assert.throws(() => parseVerificationGate('unsafe'), /off、auto 或 strict/u);

  const root = await mkdtemp(join(tmpdir(), 'echolens-verification-plan-'));
  await writeFile(join(root, 'package.json'), JSON.stringify({ scripts: { test: 'node --test', typecheck: 'tsc --noEmit' } }));
  const both = await selectVerificationPlan(root, ['src/change.ts', 'agent-test/change.test.ts']);
  assert.deepEqual(both.commands.map((command) => command.id), ['typecheck', 'test']);
  const fallback = await selectVerificationPlan(root, ['README.md']);
  assert.deepEqual(fallback.commands.map((command) => command.id), ['test']);

  const emptyRoot = await mkdtemp(join(tmpdir(), 'echolens-verification-empty-'));
  const empty = await selectVerificationPlan(emptyRoot, ['README.md']);
  assert.equal(empty.commands.length, 0);
  assert.match(empty.reason, /未找到/u);
});

test('Verification cancellation skips every command and non-required failures do not hide later checks', async () => {
  const controller = new AbortController();
  controller.abort();
  const skipped = await runVerification({ reason: 'cancelled', commands: [
    { id: 'a', label: 'a', command: 'a', executable: 'a', args: [] },
    { id: 'b', label: 'b', command: 'b', executable: 'b', args: [] },
  ] }, { signal: controller.signal, runCommand: async () => { throw new Error('must not run'); } });
  assert.deepEqual(skipped.map((result) => result.status), ['skipped', 'skipped']);

  const statuses: string[] = [];
  const result = await runVerification({ reason: 'non-required', commands: [
    { id: 'optional', label: 'optional', command: 'optional', executable: 'optional', args: [] },
    { id: 'required', label: 'required', command: 'required', executable: 'required', args: [], required: true },
  ] }, { runCommand: async (command) => {
    statuses.push(command.id);
    return { id: command.id, label: command.label, command: command.command,
      status: command.id === 'optional' ? 'failed' : 'passed', durationMs: 1, summary: command.id };
  } });
  assert.deepEqual(statuses, ['optional', 'required']);
  assert.deepEqual(result.map((item) => item.status), ['failed', 'passed']);
});

test('Verification executes argv without a shell and distinguishes failure from timeout', async () => {
  const passed = await runVerification({ reason: 'process', commands: [{
    id: 'pass', label: 'pass', command: 'node -e', executable: process.execPath,
    args: ['-e', "process.stdout.write('ok')"], required: true,
  }] });
  assert.equal(passed[0]?.status, 'passed');
  assert.match(passed[0]?.output ?? '', /ok/u);

  const failed = await runVerification({ reason: 'process', commands: [{
    id: 'fail', label: 'fail', command: 'node -e', executable: process.execPath,
    args: ['-e', "process.stderr.write('failed'); process.exit(3)"], required: true,
  }] });
  assert.equal(failed[0]?.status, 'failed');
  assert.equal(failed[0]?.exitCode, 3);

  const timeout = await runVerification({ reason: 'process', commands: [{
    id: 'timeout', label: 'timeout', command: 'node -e', executable: process.execPath,
    args: ['-e', 'setTimeout(() => {}, 1000)'], timeoutMs: 20,
  }] });
  assert.equal(timeout[0]?.status, 'timeout');
});
