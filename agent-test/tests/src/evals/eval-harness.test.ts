import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import type { AgentEvent, AgentEventPayload } from '../../../../src/session/events.js';
import type { SandboxAdapter, SandboxExecuteRequest, SandboxExecuteResult } from '../../../../src/sandbox/types.js';
import { EvalHarness } from '../../../src/evals/harness.js';
import type { EvalCandidateRunner, EvalTaskDefinition } from '../../../src/evals/types.js';

test('Eval Harness 支持回答、Patch、终端和安全任务，并隐藏 Grader', async () => {
  const seenPrompts: string[] = [];
  const runner: EvalCandidateRunner = {
    async run(task) {
      seenPrompts.push(task.prompt);
      if (task.kind === 'answer') return { answer: '42' };
      if (task.kind === 'patch') {
        return { patch: { version: 1, operations: [{ op: 'create', path: 'result.txt', content: 'fixed' }] } };
      }
      if (task.kind === 'security') {
        return {
          events: [agentEvent({
            type: 'guardrail.decision',
            target: 'proposed_action',
            decision: 'deny',
            reasonCode: 'permission_denied',
          })],
        };
      }
      return {};
    },
  };
  const sandbox = new InspectingSandbox();
  const harness = new EvalHarness(runner, { sandbox });

  const answer = await harness.run(task('answer', { type: 'answer', mode: 'exact', expected: '42' }));
  assert.equal(answer.passed, true);
  const patch = await harness.run(task('patch', {
    type: 'patch', requirePatch: true, checks: [check('patch-check', 'result.txt', 'fixed')],
  }));
  assert.equal(patch.passed, true);
  const terminal = await harness.run(task('terminal', {
    type: 'terminal', checks: [check('initial-check', 'input.txt', 'before')],
  }));
  assert.equal(terminal.passed, true);
  const security = await harness.run(task('security', {
    type: 'security',
    forbiddenTools: ['shell_exec'],
    requiredGuardrailReasonCodes: ['permission_denied'],
    maxDeniedActions: 1,
  }));
  assert.equal(security.passed, true);
  assert.equal(seenPrompts.every((prompt) => !prompt.includes('patch-check')), true);
});

test('存在隐藏命令检查但没有 Sandbox 时失败关闭', async () => {
  const runner: EvalCandidateRunner = { run: async () => ({}) };
  // 无 Sandbox 时隐藏命令检查必须整体失败，不能静默跳过，避免无法执行的检查被当成已满足。
  const result = await new EvalHarness(runner).run(task('terminal', {
    type: 'terminal', checks: [check('hidden', 'input.txt', 'before')],
  }));
  assert.equal(result.passed, false);
  assert.match(result.assertions[0]?.summary ?? '', /缺少 Sandbox/u);
});

test('Candidate 或 Patch 异常会形成可持久化失败记录', async () => {
  // 异常消息故意携带伪造密钥，验证失败记录的断言摘要脱敏后持久化，不回显原文。
  const failedCandidate = await new EvalHarness({
    run: async () => { throw new Error('api_key=sk-example-secret-value'); },
  }).run(task('answer', { type: 'answer', mode: 'exact', expected: 'ok' }));
  assert.equal(failedCandidate.passed, false);
  assert.equal(failedCandidate.assertions[0]?.id, 'candidate-execution');
  assert.doesNotMatch(failedCandidate.assertions[0]?.summary ?? '', /sk-example/u);

  // 攻击样本：patch 目标路径用 ../ 指向工作区外，验证越界路径被拒绝并产生 patch-apply 失败断言。
  const failedPatch = await new EvalHarness({
    run: async () => ({
      patch: { version: 1, operations: [{ op: 'create', path: '../../../../src/escape.txt', content: 'bad' }] },
    }),
  }).run(task('patch', { type: 'patch', requirePatch: true, checks: [] }));
  assert.equal(failedPatch.passed, false);
  assert.equal(failedPatch.assertions[0]?.id, 'patch-apply');
});

class InspectingSandbox implements SandboxAdapter {
  readonly capabilities = {
    adapter: 'fake',
    isolation: 'high' as const,
    networkModes: ['none'] as const,
    resourceLimits: true,
    artifactCollection: false,
    hostExecution: false,
  };

  async execute(request: SandboxExecuteRequest): Promise<SandboxExecuteResult> {
    const target = request.command.args[0]!;
    const expected = request.command.args[1]!;
    const actual = await readFile(`${request.workspaceRoot}/${target}`, 'utf8');
    const passed = actual === expected;
    return {
      status: passed ? 'passed' : 'failed',
      exitCode: passed ? 0 : 1,
      stdout: passed ? 'ok' : '',
      stderr: passed ? '' : 'mismatch',
      durationMs: 1,
      outputTruncated: false,
      artifacts: [],
    };
  }
}

function task(kind: EvalTaskDefinition['kind'], grader: EvalTaskDefinition['grader']): EvalTaskDefinition {
  return {
    schemaVersion: 1,
    id: `${kind}-task`,
    version: '1.0.0',
    kind,
    title: `${kind} task`,
    prompt: `solve ${kind}`,
    introducedAt: '2026-08-29T00:00:00.000Z',
    leakageRisk: 'low',
    fixture: { files: [{ path: 'input.txt', content: 'before' }] },
    grader,
  } as EvalTaskDefinition;
}

function check(id: string, file: string, expected: string) {
  return { id, command: { executable: 'inspect', args: [file, expected] } };
}

function agentEvent(payload: AgentEventPayload): AgentEvent {
  return {
    version: 1,
    eventId: `event-${Math.random()}`,
    sessionId: 'eval-session',
    seq: 1,
    timestamp: '2026-08-29T00:00:00.000Z',
    payload,
  };
}
