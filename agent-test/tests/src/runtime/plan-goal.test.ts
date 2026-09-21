import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { messageText, textMessage, type ToolCallItem } from '../../../../src/core/messages.js';
import type { ModelProvider, ProviderCapabilities, ProviderRequest, ProviderResult } from '../../../../src/providers/types.js';
import { RoutedModelProvider } from '../../../../src/runtime/model-routing.js';
import { ReactAgent } from '../../../../src/runtime/resumable-react-agent.js';
import { PLAN_FORMAT, type AgentPlan } from '../../../../src/runtime/structured-output.js';
import { ToolExecutor } from '../../../../src/runtime/tool-executor.js';
import { ToolRegistry } from '../../../../src/runtime/tool-registry.js';
import { SessionRuntime } from '../../../../src/session/session-runtime.js';

const capabilities: ProviderCapabilities = {
  maxContextTokens: 32_000,
  supportsStreaming: false,
  supportsToolCalls: true,
  supportsParallelToolCalls: false,
  supportsStructuredOutput: true,
  supportsPromptCaching: false,
  supportsUsageReporting: false,
};

const plan: AgentPlan = {
  objective: '完成目标功能',
  steps: [{ id: 's1', objective: '实现功能', verification: '运行测试', evidenceRequired: ['测试输出'] }],
  risks: ['兼容性'],
  completionCriteria: ['测试通过'],
};

class SequenceProvider implements ModelProvider {
  readonly model = 'sequence';
  readonly capabilities = capabilities;
  requests: ProviderRequest[] = [];
  constructor(private readonly results: Array<ProviderResult | ((request: ProviderRequest) => ProviderResult)>) {}
  async complete(request: ProviderRequest): Promise<ProviderResult> {
    this.requests.push(structuredClone(request));
    const next = this.results.shift();
    if (!next) throw new Error('missing result');
    return typeof next === 'function' ? next(request) : next;
  }
}

function completed(text: string): ProviderResult {
  return { output: [textMessage('answer', 'assistant', text)], stopReason: 'completed' };
}

function agentFor(root: string, routed: RoutedModelProvider, registry = new ToolRegistry()): ReactAgent {
  return new ReactAgent(routed, registry, new ToolExecutor(registry), {
    workspaceRoot: root,
    permissions: new Set(['workspace.read', 'workspace.write', 'process.exec']),
    navigationMode: 'off',
  });
}

test('PLAN_FORMAT 与 AgentPlan schema 一致并发射结构化计划事件', async () => {
  const provider = new SequenceProvider([completed(JSON.stringify(plan))]);
  const routed = new RoutedModelProvider([{ id: 'planner', provider, tier: 3, privacy: 'full-context' }],
    { defaultProfileId: 'planner' });
  routed.configure(undefined, 'plan');
  const events: import('../../../../src/session/events.js').AgentEvent[] = [];
  const result = await agentFor(process.cwd(), routed).run('制定计划', [], undefined,
    { onEvent: (event) => { events.push(event); } });

  assert.deepEqual(provider.requests[0]?.responseFormat, PLAN_FORMAT);
  assert.deepEqual(result.proposedPlan?.plan, plan);
  assert.equal(events.some((event) => event.payload.type === 'plan.proposed'
    && event.payload.plan?.objective === plan.objective), true);
  assert.equal(events.some((event) => event.payload.type === 'verification.completed'), false);
});

test('不支持结构化输出时以 raw 计划降级且不中断 run', async () => {
  const provider = new SequenceProvider([completed('先检查，再实现，最后测试')]);
  Object.assign(provider.capabilities, { supportsStructuredOutput: false });
  const routed = new RoutedModelProvider([{ id: 'planner', provider, tier: 3, privacy: 'full-context' }],
    { defaultProfileId: 'planner' });
  routed.configure(undefined, 'plan');
  const result = await agentFor(process.cwd(), routed).run('制定计划');
  assert.equal(result.state, 'completed');
  assert.equal(provider.requests[0]?.responseFormat, undefined);
  assert.equal(result.proposedPlan?.raw, '先检查，再实现，最后测试');
  assert.equal(result.proposedPlan?.plan, undefined);
});

test('运行中切到 plan 会在下一迭代收窄工具并拒绝在途写调用', async () => {
  let routed!: RoutedModelProvider;
  let writes = 0;
  const call: ToolCallItem = {
    type: 'tool_call', id: 'write-call', callId: 'write-1', callIndex: 0,
    name: 'write', arguments: {},
  };
  const provider = new SequenceProvider([
    () => {
      routed.configure(undefined, 'plan');
      return { output: [call], stopReason: 'tool_calls' };
    },
    completed(JSON.stringify(plan)),
  ]);
  routed = new RoutedModelProvider([{ id: 'model', provider, tier: 3, privacy: 'full-context' }],
    { defaultProfileId: 'model' });
  routed.configure(undefined, 'execute');
  const registry = new ToolRegistry();
  registry.register({ name: 'read', description: 'read', permission: 'workspace.read', inputSchema: { type: 'object', additionalProperties: false },
    execute: async () => ({ status: 'ok', content: 'read', summary: 'read', evidenceIds: [] }) });
  registry.register({ name: 'write', description: 'write', permission: 'workspace.write', inputSchema: { type: 'object', additionalProperties: false },
    execute: async () => { writes += 1; return { status: 'ok', content: 'write', summary: 'write', evidenceIds: [] }; } });

  const result = await agentFor(process.cwd(), routed, registry).run('执行修改');
  assert.equal(result.state, 'completed');
  assert.equal(writes, 0);
  assert.deepEqual(provider.requests[1]?.tools?.map((tool) => tool.name), ['read']);
  const denied = result.items.find((item) => item.type === 'tool_result' && item.callId === 'write-1');
  assert.equal(denied?.type === 'tool_result' && denied.error?.code, 'permission_denied');
});

test('批准计划只注入紧随其后的首个 execute run', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'echolens-plan-approval-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const provider = new SequenceProvider([completed('first'), completed('second')]);
  const routed = new RoutedModelProvider([{ id: 'model', provider, tier: 3, privacy: 'full-context' }],
    { defaultProfileId: 'model' });
  const session = await SessionRuntime.open(agentFor(root, routed), {
    rootDirectory: join(root, 'sessions'), workspaceRoot: root, sessionId: 'plan-session',
  });
  context.after(() => session.close());
  await session.setApprovedPlan('plan-1', plan);
  await session.run('开始执行');
  await session.run('下一项任务');
  const first = provider.requests[0]?.items.map((item) => item.type === 'message' ? messageText(item) : '').join('\n') ?? '';
  const second = provider.requests[1]?.items.map((item) => item.type === 'message' ? messageText(item) : '').join('\n') ?? '';
  assert.match(first, /Approved plan:[\s\S]*实现功能/u);
  assert.doesNotMatch(second, /Approved plan:/u);
});

test('获批计划在暂停和进程重启后继续注入同一 execute Turn', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'echolens-plan-resume-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const registry = new ToolRegistry();
  registry.register({
    name: 'read', description: 'read', permission: 'workspace.read',
    inputSchema: { type: 'object', additionalProperties: false },
    execute: async () => ({ status: 'ok', content: 'ok', summary: 'ok', evidenceIds: [] }),
  });
  const toolCall: ToolCallItem = {
    type: 'tool_call', id: 'read-item', callId: 'read-1', callIndex: 0, name: 'read', arguments: {},
  };
  const firstProvider = new SequenceProvider([{ output: [toolCall], stopReason: 'tool_calls' }]);
  const firstRouted = new RoutedModelProvider([{ id: 'model', provider: firstProvider, tier: 2, privacy: 'full-context' }],
    { defaultProfileId: 'model' });
  const first = await SessionRuntime.open(new ReactAgent(firstRouted, registry, new ToolExecutor(registry), {
    workspaceRoot: root, maxSteps: 1, permissions: new Set(['workspace.read']), navigationMode: 'off',
  }), { rootDirectory: join(root, 'sessions'), workspaceRoot: root, sessionId: 'resume-plan' });
  await first.setApprovedPlan('plan-resume', plan);
  const paused = await first.run('执行计划');
  assert.equal(paused.state, 'paused');
  await first.close();

  const resumedProvider = new SequenceProvider([completed('done')]);
  const resumedRouted = new RoutedModelProvider([{ id: 'model', provider: resumedProvider, tier: 2, privacy: 'full-context' }],
    { defaultProfileId: 'model' });
  const resumed = await SessionRuntime.open(agentFor(root, resumedRouted, registry), {
    rootDirectory: join(root, 'sessions'), workspaceRoot: root, sessionId: 'resume-plan',
  });
  context.after(() => resumed.close());
  await resumed.resume();
  const input = resumedProvider.requests[0]?.items
    .map((item) => item.type === 'message' ? messageText(item) : '').join('\n') ?? '';
  assert.match(input, /Approved plan:[\s\S]*实现功能/u);
});

test('最后一次拒绝决定在重启后覆盖更早的已批准计划', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'echolens-plan-rejected-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const firstProvider = new SequenceProvider([completed('unused')]);
  const firstRouted = new RoutedModelProvider([{ id: 'model', provider: firstProvider, tier: 2, privacy: 'full-context' }],
    { defaultProfileId: 'model' });
  const first = await SessionRuntime.open(agentFor(root, firstRouted), {
    rootDirectory: join(root, 'sessions'), workspaceRoot: root, sessionId: 'reject-plan',
  });
  await first.setApprovedPlan('plan-old', plan);
  await first.decidePlan('plan-new', 'rejected');
  await first.close();

  const secondProvider = new SequenceProvider([completed('done')]);
  const secondRouted = new RoutedModelProvider([{ id: 'model', provider: secondProvider, tier: 2, privacy: 'full-context' }],
    { defaultProfileId: 'model' });
  const second = await SessionRuntime.open(agentFor(root, secondRouted), {
    rootDirectory: join(root, 'sessions'), workspaceRoot: root, sessionId: 'reject-plan',
  });
  context.after(() => second.close());
  await second.run('新任务');
  const input = secondProvider.requests[0]?.items
    .map((item) => item.type === 'message' ? messageText(item) : '').join('\n') ?? '';
  assert.doesNotMatch(input, /Approved plan:/u);
});

test('Goal 注入、checkpoint/verification 证据和事件重放保持一致', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'echolens-goal-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const makeSession = async (provider: SequenceProvider) => {
    const routed = new RoutedModelProvider([{ id: 'model', provider, tier: 2, privacy: 'full-context' }],
      { defaultProfileId: 'model' });
    return SessionRuntime.open(agentFor(root, routed), {
      rootDirectory: join(root, 'sessions'), workspaceRoot: root, sessionId: 'goal-session',
    });
  };
  const firstProvider = new SequenceProvider([completed(JSON.stringify({
    answer: 'done', changes: [], verification: [], unresolved: [], warnings: [],
  }))]);
  const first = await makeSession(firstProvider);
  await first.setGoal('交付功能', ['实现', '测试']);
  await first.appendGoalEvidence('note', 'user', '需求已确认');
  await first.run('继续执行');
  const request = firstProvider.requests[0]?.items.map((item) => item.type === 'message' ? messageText(item) : '').join('\n') ?? '';
  assert.match(request, /Active goal:[\s\S]*交付功能[\s\S]*需求已确认/u);
  assert.equal((first.goalStatus()?.evidence.length ?? 0) >= 3, true);
  await first.close();

  const restored = await makeSession(new SequenceProvider([completed('unused')]));
  context.after(() => restored.close());
  assert.equal(restored.goalStatus()?.statement, '交付功能');
  assert.equal((restored.goalStatus()?.evidence.length ?? 0) >= 3, true);
  await restored.closeGoal('met');
  assert.equal(restored.goalStatus(), undefined);
});
