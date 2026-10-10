import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { redactValueWithReport } from '../../../src/providers/redaction.js';
import type { EvalRunRecord } from './types.js';
import { runEvalFiles } from './file-runner.js';
import { aggregateMetrics, calculateRunMetrics, type EvalAggregateMetrics, type EvalRunMetrics } from './metrics.js';
import { auditEvalSuite, readSuiteManifest, resolveEvalFixture, type EvalSuiteAudit } from './suite-audit.js';

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
  audit: EvalSuiteAudit;
  breakdown: {
    domain: Record<string, EvalDimensionAggregate>;
    difficulty: Record<string, EvalDimensionAggregate>;
  };
  results: Array<{
    taskId: string;
    model: 'none (static-fixture)';
    seed?: string;
    passed: boolean;
    durationMs: number;
    metrics: EvalRunMetrics;
    assertions: EvalRunRecord['assertions'];
    candidate: EvalRunRecord['candidate'];
    metadata: EvalSuiteAudit['tasks'][number];
  }>;
}

export interface EvalDimensionAggregate {
  runs: number;
  passed: number;
  successRate: number;
  layerScores: EvalAggregateMetrics['layerScores'];
}

export async function runEvalSuite(
  suiteId: string,
  resultPath: string,
  options: { docker?: { executable?: string; image?: string; user?: string } } = {},
): Promise<{ report: EvalSuiteResult; reportPath: string }> {
  const manifest = await readSuiteManifest(suiteId);
  const audit = await auditEvalSuite(suiteId);
  if (!audit.passed) throw new Error(`Eval Suite 审计失败：${formatAuditFailure(audit)}`);
  const records: Array<{ record: EvalRunRecord; seed?: string }> = [];

  for (const entry of manifest.entries) {
    const taskPath = entry.task ? resolveEvalFixture(entry.task) : undefined;
    const templatePath = entry.template ? resolveEvalFixture(entry.template) : undefined;
    if (Boolean(taskPath) === Boolean(templatePath)) throw new Error('Suite 每项必须且只能引用静态任务或动态模板');
    if (templatePath && typeof entry.seed !== 'string') throw new Error('Suite 动态任务必须固定 seed');
    if (taskPath && entry.seed !== undefined) throw new Error('静态任务不得声明 seed');
    const run = await runEvalFiles({
      taskPath,
      templatePath,
      seed: entry.seed,
      candidatePath: resolveEvalFixture(entry.candidate),
      resultPath,
      suiteId: `${manifest.id}@${manifest.version}`,
      docker: options.docker,
    });
    records.push({ record: run.record, seed: entry.seed });
  }

  const passedCount = records.filter(({ record }) => record.passed).length;
  const runMetrics = records.map(({ record }) => calculateRunMetrics(record));
  const metadataByTask = new Map(audit.tasks.map((metadata) => [metadata.taskId, metadata]));
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
    audit,
    breakdown: {
      domain: dimensionBreakdown(records, runMetrics, metadataByTask, 'domain'),
      difficulty: dimensionBreakdown(records, runMetrics, metadataByTask, 'difficulty'),
    },
    results: records.map(({ record, seed }) => ({
      taskId: record.taskId,
      model: 'none (static-fixture)',
      ...(seed === undefined ? {} : { seed }),
      passed: record.passed,
      durationMs: record.durationMs,
      metrics: calculateRunMetrics(record),
      assertions: record.assertions,
      candidate: record.candidate,
      metadata: { ...metadataByTask.get(record.taskId)! },
    })),
  };
  const reportPath = `${resultPath}.report.json`;
  await mkdir(path.dirname(path.resolve(reportPath)), { recursive: true });
  const sanitized = redactValueWithReport(report).value;
  await writeFile(reportPath, `${JSON.stringify(sanitized, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  return { report, reportPath };
}

function dimensionBreakdown(
  records: Array<{ record: EvalRunRecord }>,
  metrics: readonly EvalRunMetrics[],
  metadataByTask: ReadonlyMap<string, EvalSuiteAudit['tasks'][number]>,
  dimension: 'domain' | 'difficulty',
): Record<string, EvalDimensionAggregate> {
  const grouped = new Map<string, EvalRunMetrics[]>();
  records.forEach(({ record }, index) => {
    const value = metadataByTask.get(record.taskId)?.[dimension];
    if (!value) return;
    const items = grouped.get(value) ?? [];
    items.push(metrics[index]!);
    grouped.set(value, items);
  });
  return Object.fromEntries([...grouped.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([value, items]) => {
    const passed = items.filter((item) => item.passed).length;
    return [value, {
      runs: items.length,
      passed,
      successRate: items.length ? passed / items.length : 0,
      layerScores: aggregateMetrics(items).layerScores,
    }];
  }));
}

function formatAuditFailure(audit: EvalSuiteAudit): string {
  return [
    audit.duplicateTaskIds.length ? `重复 ID=${audit.duplicateTaskIds.join(',')}` : '',
    audit.duplicateFingerprints.length ? `重复内容=${audit.duplicateFingerprints.length}` : '',
    audit.versionMismatches.length ? `版本不一致=${audit.versionMismatches.join(',')}` : '',
    audit.metadataMissing.length ? `缺少元数据=${audit.metadataMissing.join(',')}` : '',
  ].filter(Boolean).join('；');
}
