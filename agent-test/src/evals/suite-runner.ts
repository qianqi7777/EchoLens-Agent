import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { redactValueWithReport } from '../../../src/providers/redaction.js';
import type { EvalRunRecord } from './types.js';
import { runEvalFiles } from './file-runner.js';
import { aggregateMetrics, calculateRunMetrics, type EvalAggregateMetrics, type EvalRunMetrics } from './metrics.js';

const FIXTURE_ROOT = path.resolve('agent-test/fixtures/evals');

interface EvalSuiteManifest {
  schemaVersion: 1;
  id: string;
  version: string;
  entries: Array<{
    task?: string;
    template?: string;
    seed?: string;
    candidate: string;
  }>;
}

export interface EvalSuiteResult {
  schemaVersion: 1;
  suiteId: string;
  suiteVersion: string;
  runAt: string;
  candidateMode: 'static-fixture';
  taskCount: number;
  passedCount: number;
  failedCount: number;
  successRate: number;
  totalDurationMs: number;
  aggregateMetrics: EvalAggregateMetrics;
  results: Array<{
    taskId: string;
    model: 'none (static-fixture)';
    seed?: string;
    passed: boolean;
    durationMs: number;
    metrics: EvalRunMetrics;
    assertions: EvalRunRecord['assertions'];
    candidate: EvalRunRecord['candidate'];
  }>;
}

export async function runEvalSuite(
  suiteId: string,
  resultPath: string,
  options: { docker?: { executable?: string; image?: string; user?: string } } = {},
): Promise<{ report: EvalSuiteResult; reportPath: string }> {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/u.test(suiteId)) throw new Error('Suite 名称无效');
  const suitePath = path.join(FIXTURE_ROOT, 'suites', `${suiteId}.suite.json`);
  const manifest = await readManifest(suitePath, suiteId);
  const records: Array<{ record: EvalRunRecord; seed?: string }> = [];

  for (const entry of manifest.entries) {
    const taskPath = entry.task ? resolveFixture(entry.task) : undefined;
    const templatePath = entry.template ? resolveFixture(entry.template) : undefined;
    if (Boolean(taskPath) === Boolean(templatePath)) throw new Error('Suite 每项必须且只能引用静态任务或动态模板');
    if (templatePath && typeof entry.seed !== 'string') throw new Error('Suite 动态任务必须固定 seed');
    if (taskPath && entry.seed !== undefined) throw new Error('静态任务不得声明 seed');
    const run = await runEvalFiles({
      taskPath,
      templatePath,
      seed: entry.seed,
      candidatePath: resolveFixture(entry.candidate),
      resultPath,
      suiteId: `${manifest.id}@${manifest.version}`,
      docker: options.docker,
    });
    records.push({ record: run.record, seed: entry.seed });
  }

  const passedCount = records.filter(({ record }) => record.passed).length;
  const runMetrics = records.map(({ record }) => calculateRunMetrics(record));
  const report: EvalSuiteResult = {
    schemaVersion: 1,
    suiteId: manifest.id,
    suiteVersion: manifest.version,
    runAt: new Date().toISOString(),
    candidateMode: 'static-fixture',
    taskCount: records.length,
    passedCount,
    failedCount: records.length - passedCount,
    successRate: records.length ? passedCount / records.length : 0,
    totalDurationMs: records.reduce((total, { record }) => total + record.durationMs, 0),
    aggregateMetrics: aggregateMetrics(runMetrics),
    results: records.map(({ record, seed }) => ({
      taskId: record.taskId,
      model: 'none (static-fixture)',
      ...(seed === undefined ? {} : { seed }),
      passed: record.passed,
      durationMs: record.durationMs,
      metrics: calculateRunMetrics(record),
      assertions: record.assertions,
      candidate: record.candidate,
    })),
  };
  const reportPath = `${resultPath}.report.json`;
  await mkdir(path.dirname(path.resolve(reportPath)), { recursive: true });
  const sanitized = redactValueWithReport(report).value;
  await writeFile(reportPath, `${JSON.stringify(sanitized, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  return { report, reportPath };
}

async function readManifest(filePath: string, expectedId: string): Promise<EvalSuiteManifest> {
  const manifest = JSON.parse(await readFile(filePath, 'utf8')) as Partial<EvalSuiteManifest>;
  if (manifest.schemaVersion !== 1 || manifest.id !== expectedId
    || typeof manifest.version !== 'string' || !Array.isArray(manifest.entries)
    || manifest.entries.length < 1 || manifest.entries.length > 500) {
    throw new Error(`Eval Suite 清单无效：${expectedId}`);
  }
  return manifest as EvalSuiteManifest;
}

function resolveFixture(relative: string): string {
  if (typeof relative !== 'string' || relative.length > 512 || path.isAbsolute(relative)
    || relative.split(/[\\/]/u).some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new Error('Suite fixture 路径必须是干净的相对路径');
  }
  const resolved = path.resolve(FIXTURE_ROOT, relative);
  const rel = path.relative(FIXTURE_ROOT, resolved);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('Suite fixture 路径越界');
  return resolved;
}
