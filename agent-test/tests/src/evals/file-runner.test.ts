import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { runEvalFiles } from '../../../src/evals/file-runner.js';
import { runEvalSuite } from '../../../src/evals/suite-runner.js';

test('文件 Eval 入口使用本地 Candidate 并持久化脱敏结果', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'echolens-eval-files-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const taskPath = join(root, 'task.json');
  const candidatePath = join(root, 'candidate.json');
  const resultPath = join(root, 'results.jsonl');
  await writeFile(taskPath, JSON.stringify({
    schemaVersion: 1,
    id: 'local-answer',
    version: '1.0.0',
    kind: 'answer',
    title: 'Local answer',
    prompt: 'Return local-ok',
    introducedAt: '2026-08-29T00:00:00.000Z',
    leakageRisk: 'low',
    fixture: { files: [] },
    grader: { type: 'answer', mode: 'exact', expected: 'local-ok' },
  }));
  // Candidate 元数据故意写入伪造 token，验证结果持久化前脱敏：results.jsonl 不回显原文，仅保留 [REDACTED]。
  await writeFile(candidatePath, JSON.stringify({ answer: 'local-ok', metadata: { token: 'sk-secret' } }));
  const result = await runEvalFiles({ taskPath, candidatePath, resultPath, suiteId: 'local-smoke' });
  assert.equal(result.record.passed, true);
  assert.equal(result.metrics.toolCalls, 0);
  const persisted = await readFile(resultPath, 'utf8');
  assert.doesNotMatch(persisted, /sk-secret/u);
  assert.match(persisted, /\[REDACTED\]/u);
});

test('固定 Eval Suite 按锁定任务和 seed 执行并归档可核对的结果', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'echolens-eval-suite-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const firstPath = join(root, 'fixed-first.jsonl');
  const secondPath = join(root, 'fixed-second.jsonl');

  const first = await runEvalSuite('fixed-core', firstPath);
  const firstRecords = (await readFile(firstPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as {
    taskId: string; passed: boolean; candidate: { answer?: string };
  });
  const persistedReport = JSON.parse(await readFile(first.reportPath, 'utf8')) as {
    taskCount: number;
    passedCount: number;
    failedCount: number;
    aggregateMetrics: { runs: number; successRate: number };
    results: Array<{ taskId: string; model: string; metrics: { taskId: string; passed: boolean } }>;
  };
  assert.equal(first.report.taskCount, 6);
  assert.equal(first.report.passedCount + first.report.failedCount, 6);
  assert.equal(firstRecords.length, 6);
  assert.equal(persistedReport.taskCount, firstRecords.length);
  assert.equal(persistedReport.passedCount, firstRecords.filter((record) => record.passed).length);
  assert.equal(persistedReport.failedCount, firstRecords.length - persistedReport.passedCount);
  assert.equal(persistedReport.aggregateMetrics.runs, persistedReport.taskCount);
  assert.equal(persistedReport.aggregateMetrics.successRate, persistedReport.passedCount / persistedReport.taskCount);
  assert.ok(persistedReport.results.every((record) => record.model === 'none (static-fixture)'
    && record.metrics.taskId === record.taskId));
  assert.equal(first.report.candidateMode, 'static-fixture');

  const second = await runEvalSuite('fixed-core', secondPath);
  const secondRecords = (await readFile(secondPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as { taskId: string });
  assert.deepEqual(firstRecords.map((record) => record.taskId), secondRecords.map((record) => record.taskId));
  assert.deepEqual(
    first.report.results.filter((record) => record.seed).map((record) => [record.taskId, record.seed]),
    second.report.results.filter((record) => record.seed).map((record) => [record.taskId, record.seed]),
  );
});

test('Sandbox Eval 缺少真实 Docker 时失败关闭，不生成通过记录', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'echolens-eval-docker-suite-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const result = await runEvalSuite('sandbox-smoke', join(root, 'results.jsonl'));
  assert.equal(result.report.taskCount, 1);
  assert.equal(result.report.failedCount, 1);
  assert.match(result.report.results[0]?.assertions[0]?.summary ?? '', /Sandbox/u);
});
