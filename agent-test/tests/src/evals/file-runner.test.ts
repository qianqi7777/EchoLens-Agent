import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { runEvalFiles } from '../../../src/evals/file-runner.js';

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
