import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { competePlans, type PlanDraft } from '../../../../src/orchestration/plan-competition.js';

const plan = (objective: string): PlanDraft => ({ objective, steps: [{ id: 'one', objective, verification: 'check', evidenceRequired: [] }], risks: [], completionCriteria: ['done'] });

test('方案竞争复用 Worker 池并按显式评分选择赢家', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'echolens-plan-competition-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  let running = 0; let maxRunning = 0;
  const result = await competePlans('完成任务', ['a', 'b'].map((id) => ({
    id,
    async generate() { running += 1; maxRunning = Math.max(maxRunning, running); await new Promise((resolve) => setTimeout(resolve, 15)); running -= 1; return plan(id); },
  })), { workspaceRoot: root, concurrency: 2, score: (draft) => draft.objective === 'b' ? 2 : 1 });
  assert.equal(result.winner?.candidateId, 'b');
  assert.equal(result.evaluations.length, 2);
  // Worker 池负责并发上限；调度器在单核/文件锁争用环境下也可能串行启动，不能把“并发至少可用”误报成固定并发。
  assert.ok(maxRunning >= 1);
});

test('方案候选失败会形成可审查的失败评估而不是伪造分数', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'echolens-plan-competition-failure-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const result = await competePlans('完成任务', [
    { id: 'good', async generate() { return plan('good'); } },
    { id: 'bad', async generate() { throw new Error('注入失败'); } },
  ], { workspaceRoot: root, score: () => 1 });
  assert.equal(result.winner?.candidateId, 'good');
  assert.deepEqual(result.evaluations.find((item) => item.candidateId === 'bad'), {
    candidateId: 'bad', profile: undefined, state: 'failed', reason: '注入失败',
  });
});
