import { randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { redactText } from '../providers/redaction.js';
import { applyPatch } from '../runtime/structured-patch.js';
import type { SandboxAdapter, SandboxExecuteResult } from '../sandbox/types.js';
import { assertEvalTask, normalizeRelative } from './task-validation.js';
import type {
  EvalAssertionResult,
  EvalCandidateResult,
  EvalCandidateRunner,
  EvalCommandCheck,
  EvalRunRecord,
  EvalTaskDefinition,
} from './types.js';
import type { EvalResultStore } from './result-store.js';

export interface EvalHarnessOptions {
  sandbox?: SandboxAdapter;
  resultStore?: EvalResultStore;
  retainFailedWorkspace?: boolean;
  now?: () => Date;
}

export class EvalHarness {
  private readonly now: () => Date;

  constructor(
    private readonly runner: EvalCandidateRunner,
    private readonly options: EvalHarnessOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
  }

  async run(taskValue: unknown, signal = new AbortController().signal, suiteId?: string): Promise<EvalRunRecord> {
    assertEvalTask(taskValue);
    const task = structuredClone(taskValue);
    const runId = randomUUID();
    const started = this.now();
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), `echolens-eval-${runId}-`));
    let retained = false;
    try {
      await materializeFixture(task, workspaceRoot);
      let candidate: EvalCandidateResult = {};
      const assertions: EvalAssertionResult[] = [];
      try {
        candidate = await this.runner.run(publicTask(task), workspaceRoot, signal);
      } catch (error) {
        assertions.push({ id: 'candidate-execution', passed: false, summary: `Candidate 执行失败：${safeMessage(error)}` });
      }
      if (assertions.length === 0 && candidate.patch) {
        try {
          await applyPatch(workspaceRoot, candidate.patch);
        } catch (error) {
          assertions.push({ id: 'patch-apply', passed: false, summary: `Candidate Patch 应用失败：${safeMessage(error)}` });
        }
      }
      if (assertions.length === 0) {
        try {
          assertions.push(...await grade(task, candidate, workspaceRoot, this.options.sandbox, signal));
        } catch (error) {
          assertions.push({ id: 'grader-execution', passed: false, summary: `Grader 执行失败：${safeMessage(error)}` });
        }
      }
      const completed = this.now();
      const record: EvalRunRecord = {
        schemaVersion: 1,
        runId,
        suiteId,
        taskId: task.id,
        taskVersion: task.version,
        taskKind: task.kind,
        startedAt: started.toISOString(),
        completedAt: completed.toISOString(),
        durationMs: Math.max(0, completed.getTime() - started.getTime()),
        passed: assertions.every((assertion) => assertion.passed),
        assertions,
        evidenceIds: [...new Set(candidate.evidenceIds ?? [])],
        candidate: sanitizedCandidate(candidate),
      };
      if (!record.passed && this.options.retainFailedWorkspace) {
        record.workspaceRetained = workspaceRoot;
        retained = true;
      }
      await this.options.resultStore?.append(record);
      return record;
    } finally {
      if (!retained) await rm(workspaceRoot, { recursive: true, force: true });
    }
  }
}

async function materializeFixture(task: EvalTaskDefinition, root: string): Promise<void> {
  for (const file of task.fixture.files) {
    const relative = normalizeRelative(file.path);
    const target = path.join(root, ...relative.split('/'));
    assertInside(root, target);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, file.content, { encoding: 'utf8', mode: file.executable ? 0o755 : 0o644 });
    if (file.executable) await chmod(target, 0o755);
  }
}

async function grade(
  task: EvalTaskDefinition,
  candidate: EvalCandidateResult,
  workspaceRoot: string,
  sandbox: SandboxAdapter | undefined,
  signal: AbortSignal,
): Promise<EvalAssertionResult[]> {
  const grader = task.grader;
  if (grader.type === 'answer') return [gradeAnswer(candidate.answer ?? '', grader)];
  const assertions: EvalAssertionResult[] = [];
  if (grader.type === 'patch') {
    assertions.push({
      id: 'patch-present',
      passed: !grader.requirePatch || Boolean(candidate.patch?.operations.length),
      summary: candidate.patch?.operations.length
        ? `收到 ${candidate.patch.operations.length} 个 Patch 操作`
        : '未收到 Patch',
    });
  }
  for (const check of grader.checks ?? []) {
    assertions.push(await runCheck(check, workspaceRoot, sandbox, signal));
  }
  if (grader.type === 'security') assertions.push(...gradeSecurity(candidate, grader));
  return assertions;
}

function gradeAnswer(
  answer: string,
  grader: Extract<EvalTaskDefinition['grader'], { type: 'answer' }>,
): EvalAssertionResult {
  const normalize = (value: string) => grader.caseSensitive === false ? value.toLocaleLowerCase() : value;
  const actual = normalize(answer.trim());
  const expected = normalize(grader.expected.trim());
  let passed = false;
  if (grader.mode === 'exact') passed = actual === expected;
  else if (grader.mode === 'includes') passed = actual.includes(expected);
  else passed = new RegExp(grader.expected, grader.caseSensitive === false ? 'iu' : 'u').test(answer);
  return { id: 'answer', passed, summary: passed ? '回答匹配 Grader' : '回答未匹配 Grader' };
}

async function runCheck(
  check: EvalCommandCheck,
  workspaceRoot: string,
  sandbox: SandboxAdapter | undefined,
  signal: AbortSignal,
): Promise<EvalAssertionResult> {
  if (!sandbox) return { id: check.id, passed: false, summary: '缺少 Sandbox，隐藏检查失败关闭' };
  let result: SandboxExecuteResult;
  try {
    result = await sandbox.execute({
      kind: 'test',
      command: check.command,
      workspaceRoot,
      cwd: check.cwd ?? '.',
      workspaceAccess: 'read-write',
      network: { mode: 'none' },
      resources: {
        timeoutMs: check.timeoutMs ?? 60_000,
        memoryMiB: 512,
        cpuCount: 1,
        processLimit: 64,
        maxOutputBytes: 64 * 1024,
      },
    }, signal);
  } catch (error) {
    return { id: check.id, passed: false, summary: `隐藏检查启动失败：${safeMessage(error)}` };
  }
  const expectedExitCode = check.expectedExitCode ?? 0;
  const passed = result.status === 'passed'
    && (result.exitCode ?? 0) === expectedExitCode
    && (!check.stdoutIncludes || result.stdout.includes(check.stdoutIncludes))
    && (!check.stderrIncludes || result.stderr.includes(check.stderrIncludes));
  return {
    id: check.id,
    passed,
    summary: passed ? '隐藏检查通过' : `隐藏检查失败：status=${result.status} exit=${result.exitCode ?? 'none'}`,
  };
}

function gradeSecurity(
  candidate: EvalCandidateResult,
  grader: Extract<EvalTaskDefinition['grader'], { type: 'security' }>,
): EvalAssertionResult[] {
  const events = candidate.events ?? [];
  const startedTools = events.flatMap((event) => event.payload.type === 'tool.started' ? [event.payload.toolName] : []);
  const denied = events.filter((event) => event.payload.type === 'guardrail.decision'
    && event.payload.target === 'proposed_action' && event.payload.decision === 'deny');
  const reasonCodes = new Set(events.flatMap((event) => event.payload.type === 'guardrail.decision'
    ? [event.payload.reasonCode] : []));
  const assertions: EvalAssertionResult[] = [];
  for (const tool of grader.forbiddenTools ?? []) {
    assertions.push({ id: `forbidden-tool:${tool}`, passed: !startedTools.includes(tool), summary: startedTools.includes(tool) ? `执行了禁用工具 ${tool}` : `未执行禁用工具 ${tool}` });
  }
  for (const reason of grader.requiredGuardrailReasonCodes ?? []) {
    assertions.push({ id: `guardrail:${reason}`, passed: reasonCodes.has(reason), summary: reasonCodes.has(reason) ? `观察到 Guardrail ${reason}` : `缺少 Guardrail ${reason}` });
  }
  if (grader.maxDeniedActions !== undefined) {
    assertions.push({ id: 'denied-actions', passed: denied.length <= grader.maxDeniedActions, summary: `拒绝动作 ${denied.length}/${grader.maxDeniedActions}` });
  }
  return assertions;
}

function publicTask(task: EvalTaskDefinition) {
  return {
    id: task.id,
    version: task.version,
    kind: task.kind,
    title: task.title,
    prompt: task.prompt,
    tags: [...(task.tags ?? [])],
  };
}

function sanitizedCandidate(candidate: EvalCandidateResult): EvalCandidateResult {
  return {
    answer: candidate.answer?.slice(0, 50_000),
    patch: candidate.patch,
    events: candidate.events,
    evidenceIds: [...new Set(candidate.evidenceIds ?? [])],
    metadata: candidate.metadata,
  };
}

function assertInside(root: string, candidate: string): void {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Eval Fixture 路径越界');
}

function safeMessage(error: unknown): string {
  return error instanceof Error ? redactText(error.message).slice(0, 300) : '未知错误';
}
