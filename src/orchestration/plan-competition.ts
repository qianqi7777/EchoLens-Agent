import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { rm } from 'node:fs/promises';
import { BackgroundTaskWorker } from './background-worker.js';
import { PersistentTaskQueue, type BackgroundTaskResult } from './task-queue.js';

export interface PlanDraft {
  objective: string;
  steps: Array<{ id: string; objective: string; verification: string; evidenceRequired: string[] }>;
  risks: string[];
  completionCriteria: string[];
}

export interface PlanCandidate {
  id: string;
  profile?: string;
  generate(task: string, signal: AbortSignal): Promise<PlanDraft>;
}

export interface PlanEvaluation {
  candidateId: string;
  profile?: string;
  state: 'completed' | 'failed';
  plan?: PlanDraft;
  score?: number;
  reason?: string;
}

export interface PlanCompetitionResult {
  task: string;
  winner?: PlanEvaluation;
  evaluations: PlanEvaluation[];
}

export interface PlanCompetitionOptions {
  workspaceRoot: string;
  concurrency?: number;
  score(plan: PlanDraft, candidate: PlanCandidate): number | Promise<number>;
}

/** 使用持久任务 Worker 池并行生成候选方案；选优只接受显式 score，不猜测用户偏好。 */
export async function competePlans(
  task: string,
  candidates: readonly PlanCandidate[],
  options: PlanCompetitionOptions,
  signal = new AbortController().signal,
): Promise<PlanCompetitionResult> {
  const objective = task.trim();
  if (!objective || objective.length > 50_000) throw new Error('竞争任务不能为空或过长');
  if (candidates.length === 0) throw new Error('至少需要一个方案候选');
  const unique = new Set<string>();
  for (const candidate of candidates) {
    if (!candidate.id.trim() || unique.has(candidate.id)) throw new Error(`候选 ID 重复或为空：${candidate.id}`);
    unique.add(candidate.id);
  }
  const queuePath = join(options.workspaceRoot, '.echolens', 'plan-competition', `${randomUUID()}.json`);
  const queue = new PersistentTaskQueue(queuePath);
  const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const evaluations = new Map<string, PlanEvaluation>();
  const worker = new BackgroundTaskWorker(queue, {
    async execute(record, executionSignal) {
      const candidateId = String(record.payload.metadata?.candidateId ?? '');
      const candidate = byId.get(candidateId);
      if (!candidate) return { state: 'failed', code: 'candidate_missing', retryable: false };
      if (signal.aborted || executionSignal.aborted) return { state: 'failed', code: 'cancelled', retryable: true };
      try {
        const plan = await candidate.generate(objective, executionSignal);
        const score = await options.score(plan, candidate);
        evaluations.set(candidate.id, { candidateId: candidate.id, profile: candidate.profile, state: 'completed', plan, score });
        return { state: 'completed', result: resultFor(plan, score) };
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        evaluations.set(candidate.id, { candidateId: candidate.id, profile: candidate.profile, state: 'failed', reason });
        return { state: 'failed', code: 'candidate_failed', retryable: false };
      }
    },
  }, { concurrency: options.concurrency ?? Math.min(candidates.length, 4) });
  try {
    for (const candidate of candidates) await queue.enqueue({
      isolation: 'sandbox', payload: { profile: candidate.profile ?? candidate.id, objective, metadata: { candidateId: candidate.id, workspaceKey: `plan:${candidate.id}` } },
      maxAttempts: 1,
    });
    await worker.start();
    while (true) {
      if (signal.aborted) throw new Error('方案竞争已取消');
      const records = await queue.list();
      if (records.every((record) => ['completed', 'failed', 'cancelled'].includes(record.state))) break;
      await delay(10);
    }
    const ordered = candidates.map((candidate) => evaluations.get(candidate.id) ?? {
      candidateId: candidate.id, profile: candidate.profile, state: 'failed' as const, reason: '候选未产生结果',
    });
    const completed = ordered.filter((item) => item.state === 'completed' && item.score !== undefined);
    const winner = completed.sort((left, right) => (right.score! - left.score!))[0];
    return { task: objective, winner, evaluations: ordered };
  } finally {
    await worker.stop().catch(() => undefined);
    await rm(queuePath, { force: true }).catch(() => undefined);
    await rm(`${queuePath}.lock`, { force: true }).catch(() => undefined);
  }
}

function resultFor(plan: PlanDraft, score: number): BackgroundTaskResult {
  return { summary: plan.objective, evidenceIds: [], data: { plan, score } };
}
function delay(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }
