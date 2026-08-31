import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { AgentEvent, AgentEventPayload } from '../session/events.js';
import { DynamicTaskGenerator, EvalTaskCatalog, type EvalTaskTemplate } from './dynamic-task.js';
import { aggregateMetrics, calculateRunMetrics } from './metrics.js';
import type { EvalRunRecord } from './types.js';

test('动态任务按 seed 可复现，并轮换低泄漏且最少使用的模板', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'echolens-eval-catalog-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const generator = new DynamicTaskGenerator();
  const first = template('first', 'low');
  const second = template('second', 'medium');
  // 固定模板与 seed 时生成的任务必须完全一致；更换 seed 后任务 id 必须不同，锁定 seed 与任务的一一对应。
  assert.deepEqual(generator.generate(first, 'seed-1'), generator.generate(first, 'seed-1'));
  assert.notEqual(generator.generate(first, 'seed-1').id, generator.generate(first, 'seed-2').id);

  let tick = 0;
  // 注入可控时钟：轮换排序依赖模板使用时间，固定 tick 避免依赖墙钟，保证 select 结果可复现。
  const catalog = new EvalTaskCatalog(join(root, 'catalog.json'), () => new Date(1_800_000_000_000 + tick++));
  await catalog.register([first, second]);
  assert.deepEqual((await catalog.select([first, second], 1)).map((item) => item.id), ['first']);
  assert.deepEqual((await catalog.select([first, second], 1)).map((item) => item.id), ['first']);
  await catalog.markPossibleLeak('first');
  assert.deepEqual((await catalog.select([first, second], 1)).map((item) => item.id), ['second']);
  // 故意写入损坏的 catalog：templateId 引用未注册的数字 3，验证 read() 对非法结构直接拒绝。
  await writeFile(join(root, 'catalog.json'), '{"version":1,"entries":[{"templateId":3}]}');
  await assert.rejects(catalog.read(), /Catalog 结构无效/u);
});

test('质量指标覆盖成功、回归、工具效率、成本、审批和安全事件', () => {
  const current = run('task-a', false, [
    event({ type: 'model.started', step: 0 }),
    event({ type: 'usage.recorded', model: 'model-a', usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 } }),
    event({ type: 'tool.completed', callId: '1', toolName: 'missing', callIndex: 0, status: 'invalid', elapsedMs: 3, evidenceIds: [], result: {
      type: 'tool_result', id: 'r1', callId: '1', toolName: 'missing', status: 'invalid', output: {
        id: 'o1', kind: 'tool_output', content: '', source: { type: 'tool', toolCallId: '1', toolName: 'missing' }, trust: 'untrusted', redactions: [],
      }, summary: '', evidenceIds: [], error: { code: 'unknown_tool', message: 'unknown', retryable: false },
    } }),
    event({ type: 'approval.requested', approvalId: 'a', callId: '1', permission: 'process.exec', reasonCode: 'approval_required' }),
    event({ type: 'approval.decided', approvalId: 'a', decision: 'deny', scope: 'once' }),
    event({ type: 'model.retry', step: 0, attempt: 1, delayMs: 10, code: 'rate_limit' }),
    // 安全样本：guardrail 对 tool_output 的 redact 计入注入检测，对 proposed_action 的 deny 计入权限绕过，验证两类安全指标按事件类别分别计数。
    event({ type: 'guardrail.decision', target: 'tool_output', decision: 'redact', reasonCode: 'prompt_instruction' }),
    event({ type: 'guardrail.decision', target: 'proposed_action', decision: 'deny', reasonCode: 'permission_denied' }),
    event({ type: 'turn.steered', message: 'stop' }),
  ]);
  const baseline = run('task-a', true, []);
  const metric = calculateRunMetrics(current, { 'model-a': { inputPerMillion: 2, outputPerMillion: 4 } });
  const aggregate = aggregateMetrics([metric], [calculateRunMetrics(baseline)]);
  assert.equal(metric.invalidToolCallRate, 1);
  assert.equal(metric.approvalDenials, 1);
  assert.equal(metric.promptInjectionDetections, 1);
  assert.equal(metric.permissionBypassAttempts, 1);
  assert.equal(metric.estimatedCostUsd, 0.00028);
  assert.equal(aggregate.regressionRate, 1);
});

function template(id: string, leakageRisk: EvalTaskTemplate['leakageRisk']): EvalTaskTemplate {
  return {
    schemaVersion: 1,
    id,
    version: '1.0.0',
    introducedAt: '2026-08-29T00:00:00.000Z',
    leakageRisk,
    variables: { name: { type: 'choice', values: ['alpha', 'beta'] }, count: { type: 'integer', min: 1, max: 9 } },
    task: {
      schemaVersion: 1,
      id: 'template-placeholder',
      version: '1.0.0',
      kind: 'answer',
      title: 'Template {{name}}',
      prompt: 'Return {{name}}-{{count}}',
      introducedAt: '2026-08-29T00:00:00.000Z',
      leakageRisk,
      fixture: { files: [{ path: '{{name}}.txt', content: '{{count}}' }] },
      grader: { type: 'answer', mode: 'includes', expected: '{{name}}' },
    },
  };
}

function run(taskId: string, passed: boolean, events: AgentEvent[]): EvalRunRecord {
  return {
    schemaVersion: 1,
    runId: `${taskId}-${passed}`,
    taskId,
    taskVersion: '1',
    taskKind: 'security',
    startedAt: '2026-08-29T00:00:00.000Z',
    completedAt: '2026-08-29T00:00:01.000Z',
    durationMs: 1_000,
    passed,
    assertions: [],
    evidenceIds: [],
    candidate: { events },
  };
}

let nextSeq = 0;
function event(payload: AgentEventPayload): AgentEvent {
  nextSeq += 1;
  return { version: 1, eventId: `e${nextSeq}`, sessionId: 's', seq: nextSeq, timestamp: '2026-08-29T00:00:00.000Z', payload };
}
