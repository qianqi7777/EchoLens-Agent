import { randomUUID } from 'node:crypto';
import type { ConversationItem } from '../core/messages.js';
import type { AgentRunResult, ReactAgent } from '../runtime/resumable-react-agent.js';
import type { AgentCheckpoint, AgentEvent } from './events.js';
import { JsonlEventStore, type JsonlEventStoreOptions } from './jsonl-event-store.js';
import type { LifecycleHookRunner } from '../orchestration/lifecycle-hooks.js';
import type { AgentPlan } from '../runtime/structured-output.js';
import { createGoal, createGoalEvidence, type AgentGoal, type GoalEvidence } from '../runtime/goal.js';
import { buildChangeSet, type ChangeSet } from '../runtime/change-set.js';

export interface SessionRuntimeOptions {
  rootDirectory: string;
  workspaceRoot: string;
  sessionId?: string;
  storeOptions?: JsonlEventStoreOptions;
  hooks?: LifecycleHookRunner;
}

export class SessionRuntime {
  readonly sessionId: string;
  readonly store: JsonlEventStore;
  private history: ConversationItem[] = [];
  private steeringQueue: string[] = [];
  private activeTurnId?: string;
  private pendingApprovedPlan?: AgentPlan;
  private activeGoal?: AgentGoal;
  private closed = false;

  private constructor(
    private readonly agent: ReactAgent,
    store: JsonlEventStore,
    private readonly workspaceRoot: string,
    private readonly hooks?: LifecycleHookRunner,
  ) {
    this.store = store;
    this.sessionId = store.sessionId;
  }

  static async open(agent: ReactAgent, options: SessionRuntimeOptions): Promise<SessionRuntime> {
    const store = new JsonlEventStore(
      options.rootDirectory,
      options.sessionId ?? randomUUID(),
      options.storeOptions,
    );
    const runtime = new SessionRuntime(agent, store, options.workspaceRoot, options.hooks);
    try {
      const events = await store.read();
      if (events.length === 0) {
        // 新 Session 首次落盘 session.created，把正式工作区根目录写入事件，供后续 open 校验。
        const event = await store.append({ payload: { type: 'session.created', workspaceRoot: options.workspaceRoot } });
        await options.hooks?.observe(event);
      } else {
        const created = events.find((event) => event.payload.type === 'session.created');
        if (!created || created.payload.type !== 'session.created') {
          throw new Error('Session 缺少创建事件');
        }
        // 拒绝跨工作区恢复：检查点与已恢复的工具结果绑定原工作区路径，套用到新工作区会指向错误文件。
        if (created.payload.workspaceRoot !== options.workspaceRoot) {
          throw new Error('Session 工作区与当前工作区不一致');
        }
        const checkpoint = recoverCheckpoint(events);
        runtime.history = checkpoint?.items ?? [];
        runtime.steeringQueue = pendingSteering(events);
        runtime.activeGoal = recoverGoal(events);
        runtime.pendingApprovedPlan = recoverPendingApprovedPlan(events);
        const latestRouting = events.findLast((event) => event.payload.type === 'route.configured'
          || (event.payload.type === 'checkpoint.saved' && Boolean(event.payload.checkpoint.routing)));
        if (latestRouting?.payload.type === 'route.configured') {
          agent.restoreModelRouting(latestRouting.payload.routing);
        } else if (latestRouting?.payload.type === 'checkpoint.saved' && latestRouting.payload.checkpoint.routing) {
          agent.restoreModelRouting(latestRouting.payload.checkpoint.routing);
        }
      }
      await runtime.runSessionHook(events.length === 0 ? 'startup' : 'resume');
      return runtime;
    } catch (error) {
      await store.close().catch(() => undefined);
      throw error;
    }
  }

  async run(
    userMessage: string,
    signal?: AbortSignal,
    onEvent?: (event: AgentEvent) => void | Promise<void>,
  ): Promise<AgentRunResult> {
    const turnId = randomUUID();
    this.activeTurnId = turnId;
    try {
      const approvedPlan = this.agent.executionPhase() === 'execute' ? this.pendingApprovedPlan : undefined;
      const result = await this.agent.run(userMessage, this.history, signal, {
        sessionId: this.sessionId,
        turnId,
        eventSink: this.store,
        onEvent: (event) => this.handleRuntimeEvent(event, onEvent),
        takeSteering: () => this.takeSteering(),
        approvedPlan,
        activeGoal: this.activeGoal,
        getActiveGoal: () => this.activeGoal ? structuredClone(this.activeGoal) : undefined,
      });
      this.history = result.items;
      if (approvedPlan && result.state !== 'paused') this.pendingApprovedPlan = undefined;
      return result;
    } finally {
      this.activeTurnId = undefined;
    }
  }

  async resume(
    signal?: AbortSignal,
    onEvent?: (event: AgentEvent) => void | Promise<void>,
  ): Promise<AgentRunResult> {
    const checkpoint = recoverCheckpoint(await this.store.read());
    if (!checkpoint) throw new Error('Session 没有可恢复的检查点');
    if (checkpoint.state === 'completed') throw new Error('最近一个 Turn 已完成，无需恢复');
    this.activeTurnId = checkpoint.turnId;
    try {
      const approvedPlan = this.agent.executionPhase() === 'execute' ? this.pendingApprovedPlan : undefined;
      const result = await this.agent.resume(checkpoint, signal, {
        sessionId: this.sessionId,
        eventSink: this.store,
        onEvent: (event) => this.handleRuntimeEvent(event, onEvent),
        takeSteering: () => this.takeSteering(),
        approvedPlan,
        activeGoal: this.activeGoal,
        getActiveGoal: () => this.activeGoal ? structuredClone(this.activeGoal) : undefined,
      });
      this.history = result.items;
      if (approvedPlan && result.state !== 'paused') this.pendingApprovedPlan = undefined;
      return result;
    } finally {
      this.activeTurnId = undefined;
    }
  }

  // steering 先进入队列，由下一模型请求前的 takeSteering 取走；同时落盘 turn.steered
  // 事件，恢复时通过 pendingSteering 重建队列，保证 steering 不因重启丢失。
  async steer(message: string): Promise<void> {
    const normalized = message.trim();
    if (!normalized) throw new Error('Steering 内容不能为空');
    const checkpoint = recoverCheckpoint(await this.store.read());
    const turnId = this.activeTurnId ?? checkpoint?.turnId;
    if (!turnId) throw new Error('当前 Session 没有可 steering 的 Turn');
    if (!this.activeTurnId && checkpoint?.state === 'completed') throw new Error('最近一个 Turn 已完成，请直接提交新问题');
    await this.store.append({
      turnId,
      runId: checkpoint?.runId,
      payload: { type: 'turn.steered', message: normalized },
    });
    this.steeringQueue.push(normalized);
  }

  conversation(): ConversationItem[] {
    return structuredClone(this.history);
  }

  async configureModelRouting(mode?: string, phase?: string): Promise<string[]> {
    const lines = this.agent.configureModelRouting(mode, phase);
    const routing = this.agent.modelRoutingSnapshot();
    if (routing) await this.store.append({ payload: { type: 'route.configured', routing } });
    return lines;
  }

  modelRoutingStatus(): string[] {
    return this.agent.modelRoutingStatus();
  }

  async changeSet(turnId?: string): Promise<ChangeSet | undefined> {
    const events = await this.store.read();
    const event = [...events].reverse().find((item) => item.payload.type === 'change.set.completed'
      && (turnId === undefined || item.turnId === turnId));
    if (!event || event.payload.type !== 'change.set.completed') return undefined;
    const result = await buildChangeSet(this.workspaceRoot, event.payload.checkpointIds);
    return { ...result, turnId: event.turnId, verification: event.payload.verification };
  }

  async decidePlan(
    planId: string,
    decision: 'approved' | 'edited' | 'rejected',
    plan?: AgentPlan,
  ): Promise<void> {
    if (decision !== 'rejected' && !plan) throw new Error('批准计划必须包含结构化计划');
    await this.store.append({ payload: { type: 'plan.decided', planId, decision, plan } });
    this.pendingApprovedPlan = decision === 'rejected' ? undefined : structuredClone(plan!);
    if (decision !== 'rejected') await this.configureModelRouting(undefined, 'execute');
  }

  async setApprovedPlan(planId: string, plan: AgentPlan, edited = false): Promise<void> {
    await this.decidePlan(planId, edited ? 'edited' : 'approved', plan);
  }

  async setGoal(statement: string, criteria: readonly string[] = []): Promise<AgentGoal> {
    const goal = createGoal(statement, criteria);
    await this.store.append({ payload: { type: 'goal.set', goal } });
    this.activeGoal = goal;
    return structuredClone(goal);
  }

  goalStatus(): AgentGoal | undefined {
    return this.activeGoal ? structuredClone(this.activeGoal) : undefined;
  }

  async appendGoalEvidence(kind: GoalEvidence['kind'], ref: string, summary: string): Promise<GoalEvidence> {
    if (!this.activeGoal) throw new Error('当前没有活动目标');
    const evidence = createGoalEvidence(kind, ref, summary.trim());
    await this.store.append({ payload: { type: 'goal.progress', goalId: this.activeGoal.id, evidence } });
    this.activeGoal.evidence.push(evidence);
    return structuredClone(evidence);
  }

  async closeGoal(status: 'met' | 'dropped'): Promise<void> {
    if (!this.activeGoal) throw new Error('当前没有活动目标');
    const goalId = this.activeGoal.id;
    await this.store.append({ payload: { type: 'goal.closed', goalId, status } });
    this.activeGoal = undefined;
  }

  async approvePlanAsGoal(planId: string, plan: AgentPlan, edited = false): Promise<AgentGoal> {
    await this.setApprovedPlan(planId, plan, edited);
    return this.setGoal(plan.objective, plan.steps.map((step) => step.objective));
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    let failure: unknown;
    try { await this.runSessionEndHook(); }
    catch (error) { failure = error; }
    try { await this.store.close(); }
    catch (error) { failure ??= error; }
    if (failure) throw failure;
  }

  private async takeSteering(): Promise<string[]> {
    return this.steeringQueue.splice(0, this.steeringQueue.length);
  }

  private async handleRuntimeEvent(
    event: AgentEvent,
    observer?: (event: AgentEvent) => void | Promise<void>,
  ): Promise<void> {
    await observer?.(event);
    if (event.payload.type === 'run.completed' || event.payload.type === 'run.failed'
      || event.payload.type === 'run.cancelled') this.pendingApprovedPlan = undefined;
    if (event.payload.type === 'run.completed' || event.payload.type === 'run.failed'
      || event.payload.type === 'run.cancelled' || event.payload.type === 'run.paused') {
      await this.appendChangeSet(event, observer);
    }
    if (!this.activeGoal) return;
    if (event.payload.type === 'checkpoint.saved') {
      const checkpoint = event.payload.checkpoint;
      await this.appendObservedGoalEvidence('checkpoint', event.eventId, checkpointSummary(checkpoint), observer);
    } else if (event.payload.type === 'verification.completed') {
      await this.appendObservedGoalEvidence('verification', event.eventId,
        `verified=${event.payload.verified} issueCount=${event.payload.issueCount}`, observer);
    }
  }

  private async appendChangeSet(
    terminal: AgentEvent,
    observer?: (event: AgentEvent) => void | Promise<void>,
  ): Promise<void> {
    const events = (await this.store.read()).filter((event) => event.turnId === terminal.turnId);
    const ids: string[] = [];
    for (const event of events) {
      if (event.payload.type !== 'tool.completed' || event.payload.status !== 'ok'
        || !['apply_patch', 'apply_sandbox_patch'].includes(event.payload.toolName)) continue;
      const data = event.payload.result?.data;
      if (!data || typeof data !== 'object' || Array.isArray(data)) continue;
      const id = (data as { checkpointId?: unknown }).checkpointId;
      if (typeof id === 'string' && !ids.includes(id)) ids.push(id);
    }
    if (ids.length === 0) return;
    const set = await buildChangeSet(this.workspaceRoot, ids);
    const verificationEvent = [...events].reverse().find((event) => event.payload.type === 'verification.skipped'
      || event.payload.type === 'verification.completed');
    const verification = verificationEvent?.payload.type === 'verification.skipped'
      ? { status: 'skipped' as const, issueCount: 0 }
      : verificationEvent?.payload.type === 'verification.completed'
        ? { status: verificationEvent.payload.verified ? 'passed' as const : 'failed' as const,
            issueCount: verificationEvent.payload.issueCount }
        : undefined;
    const recorded = await this.store.append({
      turnId: terminal.turnId,
      runId: terminal.runId,
      payload: {
        type: 'change.set.completed',
        files: set.files.map((file) => file.path),
        checkpointIds: ids,
        verification,
      },
    });
    await observer?.(recorded);
  }

  private async appendObservedGoalEvidence(
    kind: GoalEvidence['kind'],
    ref: string,
    summary: string,
    observer?: (event: AgentEvent) => void | Promise<void>,
  ): Promise<void> {
    if (!this.activeGoal) return;
    const evidence = createGoalEvidence(kind, ref, summary);
    const event = await this.store.append({
      payload: { type: 'goal.progress', goalId: this.activeGoal.id, evidence },
    });
    this.activeGoal.evidence.push(evidence);
    await observer?.(event);
  }

  private async runSessionHook(source: 'startup' | 'resume'): Promise<void> {
    const outcome = await this.hooks?.run({
      version: 1,
      hookEventName: 'SessionStart',
      sessionId: this.sessionId,
      cwd: this.workspaceRoot,
      source,
    });
    for (const result of outcome?.results ?? []) await this.store.append({
      payload: {
        type: 'hook.completed',
        hookId: result.hookId,
        scope: result.scope,
        hookEventName: result.hookEventName,
        status: result.status,
        durationMs: result.durationMs,
        reasonCode: result.reasonCode,
      },
    });
  }

  private async runSessionEndHook(): Promise<void> {
    const outcome = await this.hooks?.run({
      version: 1,
      hookEventName: 'SessionEnd',
      sessionId: this.sessionId,
      cwd: this.workspaceRoot,
      source: 'close',
    });
    for (const result of outcome?.results ?? []) await this.store.append({
      payload: {
        type: 'hook.completed',
        hookId: result.hookId,
        scope: result.scope,
        hookEventName: result.hookEventName,
        status: result.status,
        durationMs: result.durationMs,
        reasonCode: result.reasonCode,
      },
    });
  }
}

function checkpointFrom(payload: unknown): AgentCheckpoint | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const candidate = payload as { type?: unknown; checkpoint?: unknown };
  if (candidate.type !== 'checkpoint.saved' || !candidate.checkpoint
    || typeof candidate.checkpoint !== 'object') return undefined;
  return candidate.checkpoint as AgentCheckpoint;
}

function recoverCheckpoint(
  events: Awaited<ReturnType<JsonlEventStore['read']>>,
): AgentCheckpoint | undefined {
  const checkpointIndex = events.findLastIndex((event) => event.payload.type === 'checkpoint.saved');
  if (checkpointIndex < 0) return undefined;
  const checkpoint = checkpointFrom(events[checkpointIndex]?.payload);
  // 仅 tools 阶段需要回填已完成工具结果；model 阶段说明该批次已进入模型步骤。
  if (!checkpoint || checkpoint.phase !== 'tools') return checkpoint;
  // 恢复不变量：只合并检查点之后落盘的 tool.completed，且跳过检查点内已有 callId 的结果，
  // 防止已完成工具被重复执行；按 callIndex 排序还原 Provider 消息的稳定顺序。
  const completedIds = new Set(checkpoint.items
    .filter((item) => item.type === 'tool_result')
    .map((item) => item.callId));
  const recovered = events.slice(checkpointIndex + 1)
    .filter((event) => event.turnId === checkpoint.turnId && event.payload.type === 'tool.completed')
    .flatMap((event) => event.payload.type === 'tool.completed' && event.payload.result
      ? [event.payload.result] : [])
    .filter((result) => !completedIds.has(result.callId))
    .sort((left, right) => callIndex(checkpoint, left.callId) - callIndex(checkpoint, right.callId));
  if (recovered.length === 0) return checkpoint;
  const restored = structuredClone(checkpoint);
  restored.items.push(...recovered);
  // 回补已发生但未计入检查点预算的工具执行数，避免恢复后超出发行预算。
  restored.toolCallsUsed += recovered.filter(countsAgainstBudget).length;
  return restored;
}

// 重建未消费的 steering：只有最后一个检查点之后记录的 turn.steered 才需要交给恢复后的 run。
function pendingSteering(events: Awaited<ReturnType<JsonlEventStore['read']>>): string[] {
  const checkpointIndex = events.findLastIndex((event) => event.payload.type === 'checkpoint.saved');
  return events.slice(checkpointIndex + 1)
    .flatMap((event) => event.payload.type === 'turn.steered' ? [event.payload.message] : []);
}

function recoverGoal(events: Awaited<ReturnType<JsonlEventStore['read']>>): AgentGoal | undefined {
  let goal: AgentGoal | undefined;
  for (const event of events) {
    if (event.payload.type === 'goal.set') goal = structuredClone(event.payload.goal);
    else if (event.payload.type === 'goal.progress' && goal?.id === event.payload.goalId) {
      goal.evidence.push(structuredClone(event.payload.evidence));
    } else if (event.payload.type === 'goal.closed' && goal?.id === event.payload.goalId) {
      goal = undefined;
    }
  }
  return goal;
}

function recoverPendingApprovedPlan(
  events: Awaited<ReturnType<JsonlEventStore['read']>>,
): AgentPlan | undefined {
  const decisionIndex = events.findLastIndex((event) => event.payload.type === 'plan.decided');
  if (decisionIndex < 0) return undefined;
  const payload = events[decisionIndex]!.payload;
  if (payload.type !== 'plan.decided' || payload.decision === 'rejected' || !payload.plan) return undefined;
  if (events.slice(decisionIndex + 1).some((event) => event.payload.type === 'run.completed'
    || event.payload.type === 'run.failed' || event.payload.type === 'run.cancelled')) return undefined;
  return structuredClone(payload.plan);
}

function checkpointSummary(checkpoint: AgentCheckpoint): string {
  const writeCalls = checkpoint.items.flatMap((item) => item.type === 'tool_call'
    && /(write|patch|edit|delete|move|rename)/iu.test(item.name) ? [item] : []);
  const writeCallIds = new Set(writeCalls.map((item) => item.callId));
  const changedPaths = [
    ...writeCalls.flatMap((item) => typeof item.arguments.path === 'string' ? [item.arguments.path] : []),
    ...checkpoint.items
      .filter((item) => item.type === 'tool_result' && writeCallIds.has(item.callId))
      .flatMap((item) => item.type === 'tool_result'
        ? item.evidenceIds.filter((id) => id.startsWith('file:')).map((id) => id.slice('file:'.length))
        : []),
  ];
  const suffix = changedPaths.length > 0
    ? ` changed=${[...new Set(changedPaths)].slice(0, 10).join(',')}`
    : '';
  return `step=${checkpoint.step} phase=${checkpoint.phase} state=${checkpoint.state}${suffix}`;
}

function callIndex(checkpoint: AgentCheckpoint, callId: string): number {
  const call = checkpoint.items.find((item) => item.type === 'tool_call' && item.callId === callId);
  return call?.type === 'tool_call' ? call.callIndex : Number.MAX_SAFE_INTEGER;
}

// 这些错误码代表工具未真正执行（被拒、预算耗尽、未知工具、参数无效），不计入预算。
function countsAgainstBudget(result: ConversationItem & { type: 'tool_result' }): boolean {
  return ![
    'approval_required',
    'permission_denied',
    'hook_denied',
    'budget_exhausted',
    'unknown_tool',
    'invalid_arguments',
  ].includes(result.error?.code ?? '');
}
