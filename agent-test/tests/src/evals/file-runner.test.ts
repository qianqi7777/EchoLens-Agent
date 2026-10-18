import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Script } from 'node:vm';
import { runEvalFiles } from '../../../src/evals/file-runner.js';
import { runEvalSuite } from '../../../src/evals/suite-runner.js';
import { readSuiteManifest } from '../../../src/evals/suite-audit.js';
import { readEvalTask } from '../../../src/evals/task-catalog.js';
import { EvalHarness } from '../../../src/evals/harness.js';
import { runtimeCandidate } from '../../../src/evals/runtime-candidate.js';

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
  assert.equal(first.report.taskCount, 10);
  assert.equal(first.report.passedCount + first.report.failedCount, 10);
  assert.equal(firstRecords.length, 10);
  assert.equal(persistedReport.taskCount, firstRecords.length);
  assert.equal(persistedReport.passedCount, firstRecords.filter((record) => record.passed).length);
  assert.equal(persistedReport.failedCount, firstRecords.length - persistedReport.passedCount);
  assert.equal(persistedReport.aggregateMetrics.runs, persistedReport.taskCount);
  assert.equal(persistedReport.aggregateMetrics.successRate, persistedReport.passedCount / persistedReport.taskCount);
  assert.ok(persistedReport.results.every((record) => record.model === 'none (static-fixture)'
    && record.metrics.taskId === record.taskId));
  assert.equal(first.report.candidateMode, 'static-fixture');
  assert.equal(first.report.audit.passed, true);
  assert.equal(first.report.audit.entries, 10);
  assert.equal(first.report.audit.uniqueTaskIds, 10);
  assert.deepEqual(first.report.audit.duplicateTaskIds, []);
  assert.deepEqual(first.report.audit.duplicateFingerprints, []);
  assert.equal(first.report.breakdown.domain.coding?.runs, 2);
  assert.equal(first.report.breakdown.domain.security?.successRate, 1);
  assert.ok(first.report.results.every((record) => record.metadata.domain && record.metrics.scores.efficiency.covered));

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

test('120 项固定任务运行真实工具链，空结果、错误修复和缺失拒绝证据不能通过', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'echolens-fixed-coding-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { report } = await runEvalSuite('fixed-coding', join(root, 'reference.jsonl'));
  assert.equal(report.taskCount, 120);
  assert.equal(report.passedCount, 120);
  assert.equal(report.candidateMode, 'runtime-scripted');
  assert.equal(report.audit.uniqueTaskIds, 120);
  assert.deepEqual(report.audit.duplicateFingerprints, []);
  assert.ok(report.results.every((result) => result.model === 'local-scripted-provider'
    && result.candidate.events?.some((event) => event.payload.type === 'run.completed')));
  assert.equal(report.results.filter((result) => result.metadata.kind === 'security').length, 60);
  const manifest = await readSuiteManifest('fixed-coding');
  for (const entry of manifest.entries) {
    const task = await readEvalTask(join('agent-test/fixtures/evals', entry.task!), entry.taskId);
    const empty = await new EvalHarness({ run: async () => ({}) }).run(task);
    assert.equal(empty.passed, false, `${task.id}: empty candidate`);
    if (task.kind === 'patch') {
      const file = task.fixture.files[0]!;
      if (file.path.endsWith('.cjs') && task.grader.type === 'patch') {
        // Compile the trusted reference fixture without executing candidate code on the host.
        assert.doesNotThrow(() => new Script(task.grader.type === 'patch' ? task.grader.fileChecks![0]!.contentEquals! : ''));
      }
      const unchanged = runtimeCandidate({ calls: [{ name: 'apply_patch', arguments: { patch: { version: 1,
        operations: [{ op: 'replace', path: file.path, oldString: file.content, newString: file.content }] } } }] });
      const wrong = await new EvalHarness(unchanged, { candidateAppliesPatch: true }).run(task);
      assert.equal(wrong.passed, false, `${task.id}: unchanged patch`);
    } else {
      const safe = runtimeCandidate({ calls: [{ name: 'read_file', arguments: { path: 'request.json' } }],
        events: [{ payload: { type: 'guardrail.decision', decision: 'deny' } }] });
      const wrong = await new EvalHarness(safe, { candidateAppliesPatch: true }).run(task);
      assert.equal(wrong.passed, false, `${task.id}: fabricated events cannot replace runtime evidence`);
    }
  }
});
