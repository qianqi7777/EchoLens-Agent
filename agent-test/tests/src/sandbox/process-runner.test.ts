import assert from 'node:assert/strict';
import test from 'node:test';
import { NodeProcessRunner } from '../../../../src/sandbox/process-runner.js';

test('Process Runner 不解析 Shell 元字符并限制输出', async () => {
  // 注入样本：参数含 ; 等 Shell 元字符，验证 runner 以 shell:false 原样传递、不经 Shell 执行。
  const runner = new NodeProcessRunner();
  const literal = 'literal;echo should-not-run';
  const executed = await runner.run({
    executable: process.execPath,
    args: ['-e', 'process.stdout.write(process.argv[1])', literal],
    timeoutMs: 5_000,
    maxOutputBytes: 4_096,
  });
  assert.equal(executed.exitCode, 0);
  assert.equal(executed.stdout, literal);
  assert.equal(executed.stderr, '');

  const bounded = await runner.run({
    executable: process.execPath,
    args: ['-e', 'process.stdout.write("x".repeat(5000))'],
    timeoutMs: 5_000,
    maxOutputBytes: 1_024,
  });
  assert.equal(bounded.stdout.length, 1_024);
  assert.equal(bounded.outputTruncated, true);
});
test('Process Runner 区分超时与外部取消', async () => {
  // 两种终止都 kill 子进程，但结果标记不同：超时由定时器触发，取消由 AbortSignal 触发。
  const runner = new NodeProcessRunner();
  const timedOut = await runner.run({
    executable: process.execPath,
    args: ['-e', 'setInterval(() => undefined, 1000)'],
    timeoutMs: 100,
    maxOutputBytes: 1_024,
  });
  assert.equal(timedOut.timedOut, true);
  assert.equal(timedOut.cancelled, false);

  const controller = new AbortController();
  setTimeout(() => controller.abort(), 50);
  const cancelled = await runner.run({
    executable: process.execPath,
    args: ['-e', 'setInterval(() => undefined, 1000)'],
    timeoutMs: 5_000,
    maxOutputBytes: 1_024,
    signal: controller.signal,
  });
  assert.equal(cancelled.cancelled, true);
  assert.equal(cancelled.timedOut, false);
});
