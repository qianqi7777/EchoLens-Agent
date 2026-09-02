import type { AgentEvent } from '../../../src/session/events.js';
import type { StructuredPatch } from '../../../src/runtime/structured-patch.js';

export type EvalTaskKind = 'answer' | 'patch' | 'terminal' | 'security';
export type LeakageRisk = 'low' | 'medium' | 'high' | 'known_leaked';

export interface EvalFixtureFile {
  path: string;
  content: string;
  executable?: boolean;
}

export interface EvalCommandCheck {
  id: string;
  command: { executable: string; args: string[] };
  cwd?: string;
  timeoutMs?: number;
  expectedExitCode?: number;
  stdoutIncludes?: string;
  stderrIncludes?: string;
}

export type EvalGrader =
  | { type: 'answer'; mode: 'exact' | 'includes' | 'regex'; expected: string; caseSensitive?: boolean }
  | { type: 'patch'; requirePatch: boolean; checks: EvalCommandCheck[] }
  | { type: 'terminal'; checks: EvalCommandCheck[] }
  | {
      type: 'security';
      checks?: EvalCommandCheck[];
      forbiddenTools?: string[];
      requiredGuardrailReasonCodes?: string[];
      maxDeniedActions?: number;
    };

export interface EvalTaskDefinition {
  schemaVersion: 1;
  id: string;
  version: string;
  kind: EvalTaskKind;
  title: string;
  prompt: string;
  introducedAt: string;
  lastUsedAt?: string;
  leakageRisk: LeakageRisk;
  tags?: string[];
  fixture: { files: EvalFixtureFile[] };
  grader: EvalGrader;
  generator?: { templateId: string; seed: string; variables: Record<string, string | number> };
}

export interface EvalCandidateTask {
  id: string;
  version: string;
  kind: EvalTaskKind;
  title: string;
  prompt: string;
  tags: string[];
}

export interface EvalCandidateResult {
  answer?: string;
  patch?: StructuredPatch;
  events?: AgentEvent[];
  evidenceIds?: string[];
  metadata?: Record<string, string | number | boolean | null>;
}

export interface EvalCandidateRunner {
  /**
   * 在独立工作区运行候选任务。
   *
   * 仅传入 publicTask，不含 grader/fixture/generator，候选无法获取评分标准；workspaceRoot
   * 为每次运行新建的临时工作区。实现必须返回纯结果且不依赖外部共享状态，以维持
   * 任务→结果一一对应的隔离不变量。
   */
  run(
    task: EvalCandidateTask,
    workspaceRoot: string,
    signal: AbortSignal,
  ): Promise<EvalCandidateResult>;
}

export interface EvalAssertionResult {
  id: string;
  passed: boolean;
  summary: string;
}

export interface EvalRunRecord {
  schemaVersion: 1;
  runId: string;
  suiteId?: string;
  taskId: string;
  taskVersion: string;
  taskKind: EvalTaskKind;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  passed: boolean;
  assertions: EvalAssertionResult[];
  evidenceIds: string[];
  candidate: EvalCandidateResult;
  workspaceRetained?: string;
}
