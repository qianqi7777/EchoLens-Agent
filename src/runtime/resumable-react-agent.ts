import { randomUUID } from 'node:crypto';
import {
  isMessageItem,
  isToolCallItem,
  messageText,
  textMessage,
  type ConversationItem,
  type ToolCallItem,
  type ToolResultItem,
} from '../core/messages.js';
import { systemPolicyMessage } from '../core/system-policy.js';
import {
  ContextManager,
  type ContextPrivacyLevel,
  type ContextBuildResult,
} from '../context/context-manager.js';
import {
  isModelProviderRunLifecycle,
} from '../providers/types.js';
import type {
  ModelProvider,
  ModelToolDefinition,
  ProviderRequest,
  ProviderResult,
  ToolChoice,
} from '../providers/types.js';
import type {
  AgentCheckpoint,
  AgentEvent,
  AgentEventIntent,
  AgentEventSink,
  RunState,
  RuntimeHookContext,
} from '../session/events.js';
import { ToolExecutor } from './tool-executor.js';
import { ToolRegistry } from './tool-registry.js';
import { ToolScheduler } from './tool-scheduler.js';
import {
  createToolOutputContextItem,
  toolOutputGuardrailDecision,
} from './tool-output.js';
import {
  FINAL_SUMMARY_FORMAT,
  PLAN_FORMAT,
  parseAgentPlan,
  parseFinalSummary,
  type AgentPlan,
  type StructuredOutputResult,
  type FinalSummary,
} from './structured-output.js';
import type {
  AgentTraceItem,
  Permission,
  ToolContext,
  ToolResult,
  ToolSpec,
} from './types.js';
import type { LifecycleHookRunner } from '../orchestration/lifecycle-hooks.js';
import { navigationResolverFor, type NavigationResolver } from '../navigation/navigation-resolver.js';
import type { NavigationHint } from '../navigation/types.js';
import type { AgentGoal } from './goal.js';
import type { ExecutionPhase } from './model-routing.js';
import { selectVerificationPlan, type EditVerificationResult } from './verification.js';
import { SkillLoader } from '../skills/loader.js';
import type { LoadedSkill } from '../skills/loader.js';
import { SkillRuntime } from '../skills/skill-runtime.js';
import type { PermissionProfile } from './permission-profile.js';
import type { GitHistoryProvider } from '../navigation/git-history.js';

/**
 * 一次 run/resume 的完整结果。
 *
 * `answer` 在结构化摘要校验通过时取自摘要字段，否则回退为未验证的 raw 输出；
 * `checkpoint` 保存完整 items，供后续 resume 继续执行。
 */
export interface AgentRunResult {
  answer: string;
  items: ConversationItem[];
  trace: AgentTraceItem[];
  degraded: boolean;
  state: RunState;
  sessionId: string;
  turnId: string;
  runId: string;
  checkpoint: AgentCheckpoint;
  finalSummary: StructuredOutputResult<FinalSummary>;
  proposedPlan?: { planId: string; plan?: AgentPlan; raw?: string };
}

export interface AgentRunRuntime {
  sessionId?: string;
  turnId?: string;
  eventSink?: AgentEventSink;
  onEvent?: (event: AgentEvent) => void | Promise<void>;
  takeSteering?: () => Promise<string[]>;
  approvedPlan?: AgentPlan;
  activeGoal?: AgentGoal;
  getActiveGoal?: () => AgentGoal | undefined;
}

export interface ReactAgentOptions {
  maxSteps?: number;
  maxHistoryTurns?: number;
  workspaceRoot: string;
  permissions?: ReadonlySet<Permission>;
  privacy?: ContextPrivacyLevel;
  instructionTarget?: string;
  contextManager?: ContextManager;
  toolScheduler?: ToolScheduler;
  hooks?: LifecycleHookRunner;
  navigationMode?: 'auto' | 'off';
  navigationResolver?: NavigationResolver;
  verificationGate?: 'off' | 'auto' | 'strict';
  skillLoader?: SkillLoader;
  skillRuntime?: SkillRuntime;
  permissionProfile?: PermissionProfile;
  gitHistory?: GitHistoryProvider;
}

interface RunMachine {
  sessionId: string;
  turnId: string;
  runId: string;
  step: number;
  phase: AgentCheckpoint['phase'];
  items: ConversationItem[];
  trace: AgentTraceItem[];
  parentEventId?: string;
  onEvent?: (event: AgentEvent) => void | Promise<void>;
  takeSteering?: () => Promise<string[]>;
  hooks?: LifecycleHookRunner;
  hookContexts: RuntimeHookContext[];
  navigationHint?: NavigationHint;
  approvedPlan?: AgentPlan;
  activeGoal?: AgentGoal;
  getActiveGoal?: () => AgentGoal | undefined;
  lastResponsePhase?: ExecutionPhase;
  internalVerificationCallIds: Set<string>;
  activeSkills: LoadedSkill[];
}

/** 显式、可检查点恢复的 model -> tools -> model 状态机。 */
export class ReactAgent {
  private readonly contextManager: ContextManager;
  private readonly toolScheduler: ToolScheduler;
  private readonly navigationResolver: NavigationResolver;
  private readonly skillRuntime?: SkillRuntime;
  private pauseRequested = false;

  constructor(
    private readonly model: ModelProvider,
    private readonly registry: ToolRegistry,
    private readonly executor: ToolExecutor,
    private readonly options: ReactAgentOptions,
  ) {
    const skillLoader = options.skillLoader ?? new SkillLoader({
      workspaceRoot: options.workspaceRoot,
      toolRegistry: registry,
      allowedPermissions: options.permissions,
    });
    this.contextManager = options.contextManager ?? new ContextManager({
      workspaceRoot: options.workspaceRoot,
      maxHistoryTurns: options.maxHistoryTurns,
      skillLoader,
      gitHistory: options.gitHistory,
    });
    this.toolScheduler = options.toolScheduler ?? new ToolScheduler();
    this.navigationResolver = options.navigationResolver ?? navigationResolverFor(options.workspaceRoot);
    this.skillRuntime = options.skillRuntime ?? new SkillRuntime(skillLoader);
  }

  /** 请求在当前工具批次完成后、下一次模型调用前暂停，不打断在途工具。 */
  requestPause(): void {
    this.pauseRequested = true;
  }

  /** 返回最近一次模型请求实际使用的上下文来源报告。 */
  contextReport(): ContextBuildResult | undefined {
    return this.contextManager.report();
  }

  /**
   * 发起一轮新对话。
   *
   * 历史里 role=system 的消息会被过滤（见下），确保系统指令只能来自 System Policy；
   * 首次进入前先保存一次 checkpoint，之后每一步的状态都可在任意时刻恢复。
   */
  async run(
    userMessage: string,
    history: ConversationItem[] = [],
    signal?: AbortSignal,
    runtime: AgentRunRuntime = {},
  ): Promise<AgentRunResult> {
    this.pauseRequested = false;
    if (isModelProviderRunLifecycle(this.model)) await this.model.beginRun(userMessage);
    const sessionId = runtime.sessionId ?? randomUUID();
    const turnId = runtime.turnId ?? randomUUID();
    const runId = randomUUID();
    let nextItem = 0;
    const itemId = (kind: string) => `${runId}:${kind}:${nextItem += 1}`;
    const machine: RunMachine = {
      sessionId,
      turnId,
      runId,
      step: 0,
      phase: 'model',
      // system 指令仅源于 System Policy：历史中 role=system 的消息被过滤，
      // 防止外部对话记录注入伪系统指令或绕过既定规则优先级。
      items: [
        systemPolicyMessage(),
        ...history.filter((item) => item.type !== 'message' || item.role !== 'system'),
        textMessage(itemId('message'), 'user', userMessage),
      ],
      trace: [],
      onEvent: runtime.onEvent,
      takeSteering: runtime.takeSteering,
      hooks: this.options.hooks,
      hookContexts: [],
      navigationHint: this.options.navigationMode === 'off'
        ? undefined
        : await this.navigationResolver.resolve(userMessage),
      approvedPlan: runtime.approvedPlan,
      activeGoal: runtime.activeGoal,
      getActiveGoal: runtime.getActiveGoal,
      internalVerificationCallIds: new Set(),
      activeSkills: [],
    };
    this.executor.resetBudget();
    await emit(machine, runtime.eventSink, { payload: { type: 'turn.started', userMessage } });
    await emit(machine, runtime.eventSink, {
      payload: { type: 'run.started', model: this.model.model, resumed: false },
    });
    const promptHooks = await this.runCommandHooks(machine, runtime.eventSink, {
      version: 1,
      hookEventName: 'UserPromptSubmit',
      sessionId,
      turnId,
      runId,
      cwd: this.options.workspaceRoot,
      prompt: userMessage,
    }, signal);
    machine.hookContexts = promptHooks.contexts;
    if (promptHooks.decision === 'deny') {
      return this.fail(machine, runtime.eventSink, 'hook_denied', promptHooks.reason ?? 'Hook 拒绝了当前请求');
    }
    await this.emitNavigationEvent(machine, runtime.eventSink);
    await this.emitRouteEvents(machine, runtime.eventSink);
    await this.saveCheckpoint(machine, runtime.eventSink);
    return this.execute(machine, signal, runtime.eventSink);
  }

  async resume(
    checkpoint: AgentCheckpoint,
    signal?: AbortSignal,
    runtime: AgentRunRuntime = {},
  ): Promise<AgentRunResult> {
    this.pauseRequested = false;
    if (isModelProviderRunLifecycle(this.model)) await this.model.beginResume(checkpoint.routing);
    if (runtime.sessionId && runtime.sessionId !== checkpoint.sessionId) {
      throw new Error('Checkpoint 不属于当前 Session');
    }
    const machine: RunMachine = {
      sessionId: checkpoint.sessionId,
      turnId: checkpoint.turnId,
      runId: randomUUID(),
      step: checkpoint.step,
      phase: checkpoint.phase === 'finished' ? 'model' : checkpoint.phase,
      items: structuredClone(checkpoint.items),
      trace: [],
      onEvent: runtime.onEvent,
      takeSteering: runtime.takeSteering,
      hooks: this.options.hooks,
      hookContexts: structuredClone(checkpoint.hookContexts ?? []),
      navigationHint: this.options.navigationMode === 'off'
        ? undefined
        : await this.navigationResolver.resolve(latestUserText(checkpoint.items)),
      approvedPlan: runtime.approvedPlan,
      activeGoal: runtime.activeGoal,
      getActiveGoal: runtime.getActiveGoal,
      internalVerificationCallIds: pendingAutomaticVerificationCallIds(
        checkpoint.items, checkpoint.internalVerificationCallIds ?? [],
      ),
      activeSkills: [],
    };
    // A resume is an explicit request for another bounded execution slice.
    // Completed tool results stay in the checkpoint, while runtime budgets are
    // refreshed so step/tool budget pauses can actually make progress.
    this.executor.resetBudget();
    await emit(machine, runtime.eventSink, {
      payload: { type: 'run.started', model: this.model.model, resumed: true },
    });
    await this.emitNavigationEvent(machine, runtime.eventSink);
    await this.emitRouteEvents(machine, runtime.eventSink);
    return this.execute(machine, signal, runtime.eventSink);
  }

  private async execute(
    machine: RunMachine,
    signal: AbortSignal | undefined,
    eventSink: AgentEventSink | undefined,
  ): Promise<AgentRunResult> {
    // 本次 execute 全程复用同一个 itemId 工厂，计数器从已有 items 数量起步并持续递增，
    // 跨越 model/tools 多次循环及恢复后都不产生重复 ID。
    const itemId = itemIdFactory(machine.runId, machine.items.length);
    // stepLimit 从 checkpoint 步数起算而非从 0 计数：恢复后的每个新片段都只获得
    // 一份 maxSteps 预算，已耗步数不重复计，因此不会因多次恢复而无限延长执行。
    const stepLimit = machine.step + (this.options.maxSteps ?? 8);
    while (machine.step < stepLimit) {
      if (signal?.aborted) return this.cancel(machine, eventSink, signal.reason);

      // 阶段可以在运行中通过 /plan 切换；每一轮重算权限，确保下一次模型请求
      // 立即看到收窄后的工具集合，且在途写调用仍由 guardrail 拒绝。
      const runtimePermissions = effectiveRuntimePermissions(
        this.options.permissions ?? new Set<Permission>(['workspace.read']), this.model,
      );

      // tools 阶段先执行所有挂起工具；执行结果决定继续、暂停还是取消。
      if (machine.phase === 'tools') {
        if (isModelProviderRunLifecycle(this.model)) this.model.markToolsStarted();
        const pending = pendingToolCalls(machine.items);
        const result = await this.executeTools(
          machine,
          pending,
          runtimePermissions,
          signal,
          itemId,
          eventSink,
        );
        if (result === 'cancelled') return this.cancel(machine, eventSink, signal?.reason);
        if (result === 'budget_exhausted') return this.pause(machine, eventSink, 'tool_budget');
        if (result === 'approval_required') return this.pause(machine, eventSink, 'approval_required');
        if (result === 'verification_failed') return this.pause(machine, eventSink, 'verification_failed');
        machine.phase = 'model';
        machine.step += 1;
        await this.saveCheckpoint(machine, eventSink);
        if (this.pauseRequested) {
          this.pauseRequested = false;
          return this.pause(machine, eventSink, 'user_paused');
        }
        continue;
      }

      await this.applySteering(machine, itemId, eventSink);
      if (this.pauseRequested) {
        this.pauseRequested = false;
        return this.pause(machine, eventSink, 'user_paused');
      }

      // 首轮强制只读只持续到首次工具结果。成功结果可作为证据；失败结果也必须交还模型解释或
      // 修正，不能再次强制工具调用并覆盖 permission_denied 等确定性结论。
      const navigationPending = Boolean(machine.navigationHint) && !hasToolResultInCurrentTurn(machine.items);
      const requestPhase = isModelProviderRunLifecycle(this.model) ? this.model.currentPhase() : 'execute';
      const discoveryTools = providerTools(this.model, this.registry, runtimePermissions, true);
      const discovery = navigationPending && Boolean(discoveryTools?.length);
      const tools = discovery ? discoveryTools : providerTools(this.model, this.registry, runtimePermissions);
      const toolChoice = requestToolChoice(this.model, machine.navigationHint, discovery, tools);
      if (this.skillRuntime) {
        try {
          machine.activeSkills = [...(await this.skillRuntime.activateForPrompt(latestUserText(machine.items))).skills];
        } catch (error) {
          machine.activeSkills = [];
          machine.trace.push({ type: 'warning', message: `Skill 自动激活被拒绝：${error instanceof Error ? error.message : String(error)}` });
        }
      }
      await emit(machine, eventSink, {
        payload: {
          type: 'model.started',
          step: machine.step,
          toolChoice,
          navigationMode: machine.navigationHint?.mode ?? 'none',
        },
      });
      let response;
      try {
        const prepared = await this.contextManager.build(machine.items, {
          privacy: this.options.privacy ?? 'full-context',
          providerMaxContextTokens: this.model.capabilities.maxContextTokens,
          runtimePermissions,
          targetPath: latestInstructionTarget(machine.items, this.options.instructionTarget),
          navigationHint: navigationPending ? machine.navigationHint : undefined,
          hookContexts: machine.hookContexts,
          approvedPlan: requestPhase === 'execute' ? machine.approvedPlan : undefined,
          activeGoal: requestPhase === 'execute'
            ? (machine.getActiveGoal?.() ?? machine.activeGoal)
            : undefined,
          activeSkills: machine.activeSkills,
          gitHistoryPaths: uniquePaths([
            ...(navigationPending ? machine.navigationHint?.candidatePaths ?? [] : []),
            ...(this.options.instructionTarget ? [this.options.instructionTarget] : []),
          ]),
        });
        response = await this.completeModel(machine, eventSink, {
          items: prepared.items,
          tools,
          toolChoice,
          responseFormat: !discovery && this.model.capabilities.supportsStructuredOutput
            ? (requestPhase === 'plan'
                ? PLAN_FORMAT
                : FINAL_SUMMARY_FORMAT)
            : undefined,
          signal,
        });
        await this.emitRouteEvents(machine, eventSink);
        machine.lastResponsePhase = requestPhase;
      } catch (error) {
        await this.emitRouteEvents(machine, eventSink);
        // 请求失败后先判定中止：已中止则按取消处理而不是失败重试，
        // 避免中止的运行被恢复或触发重试并再次计费。
        if (signal?.aborted) return this.cancel(machine, eventSink, signal.reason);
        const code = errorCode(error);
        await emit(machine, eventSink, {
          payload: { type: 'model.failed', step: machine.step, code, retryable: errorRetryable(error) },
        });
        await this.saveCheckpoint(machine, eventSink, 'failed');
        await emit(machine, eventSink, {
          payload: { type: 'run.failed', code, retryable: errorRetryable(error) },
        });
        await this.runStopHooks(machine, eventSink, 'failed', true, stopReasonMessage(code));
        throw error;
      }

      const toolCalls = response.output.filter(isToolCallItem);
      machine.items.push(...response.output);
      machine.trace.push({
        type: 'model',
        message: toolCalls.length ? `模型请求 ${toolCalls.length} 个工具` : '模型生成最终回答',
      });
      await emit(machine, eventSink, {
        payload: {
          type: 'model.completed',
          step: machine.step,
          stopReason: response.stopReason,
          requestId: response.requestId,
          usage: response.usage,
          elapsedMs: response.transport?.elapsedMs,
          retries: response.transport?.retries,
          toolCallCount: toolCalls.length,
        },
      });
      if (response.usage) {
        await emit(machine, eventSink, {
          payload: {
            type: 'usage.recorded',
            model: this.model.model,
            usage: response.usage,
            cachedReadTokens: response.cache?.readTokens,
          },
        });
      }

      if (toolCalls.length > 0) {
        if (response.stopReason !== 'tool_calls' && response.stopReason !== 'completed') {
          machine.trace.push({
            type: 'warning',
            message: `模型返回工具调用，但停止原因是 ${response.stopReason}`,
          });
          return this.finish(machine, stopReasonMessage(response.stopReason), true, 'failed', eventSink);
        }
        machine.phase = 'tools';
        await this.saveCheckpoint(machine, eventSink);
        continue;
      }

      if (toolChoice === 'required') {
        machine.trace.push({ type: 'warning', message: 'tool_required：模型未返回所需的只读工具调用' });
        return this.fail(machine, eventSink, 'tool_required', '模型未按要求返回只读工具调用。');
      }

      const answer = assistantText(response.output);
      if (response.stopReason === 'completed') {
        return this.finish(machine, answer, false, 'completed', eventSink);
      }
      machine.trace.push({ type: 'warning', message: `模型未正常完成：${response.stopReason}` });
      return this.finish(
        machine,
        answer || stopReasonMessage(response.stopReason),
        true,
        response.stopReason === 'cancelled' ? 'cancelled' : 'failed',
        eventSink,
      );
    }
    return this.pause(machine, eventSink, 'step_budget');
  }

  private async completeModel(
    machine: RunMachine,
    eventSink: AgentEventSink | undefined,
    request: ProviderRequest,
  ): Promise<ProviderResult> {
    if (!this.model.capabilities.supportsStreaming || !this.model.stream) {
      return this.model.complete(request);
    }
    let completed: ProviderResult | undefined;
    for await (const event of this.model.stream(request)) {
      if (event.type === 'output_text.delta') {
        await emit(machine, eventSink, {
          payload: { type: 'model.output.delta', step: machine.step, delta: event.delta },
        });
      } else if (event.type === 'transport.retry') {
        await emit(machine, eventSink, {
          payload: {
            type: 'model.retry',
            step: machine.step,
            attempt: event.attempt,
            delayMs: event.delayMs,
            code: event.code,
          },
        });
      } else if (event.type === 'response.completed') {
        completed = event.result;
      }
    }
    if (!completed) throw new Error('Provider 流结束但没有最终结果');
    return completed;
  }

  restoreModelRouting(snapshot: import('../providers/types.js').ModelRoutingSnapshot): void {
    if (isModelProviderRunLifecycle(this.model)) this.model.restore(snapshot);
  }

  configureModelRouting(mode?: string, phase?: string): string[] {
    if (!isModelProviderRunLifecycle(this.model)) return ['当前模型不支持会话内路由配置'];
    return this.model.configure(mode, phase);
  }

  modelRoutingStatus(): string[] {
    return isModelProviderRunLifecycle(this.model) ? this.model.status() : [`model=${this.model.model}`];
  }

  executionPhase(): 'plan' | 'execute' | 'verify' {
    return isModelProviderRunLifecycle(this.model) ? this.model.currentPhase() : 'execute';
  }

  modelRoutingSnapshot(): import('../providers/types.js').ModelRoutingSnapshot | undefined {
    return isModelProviderRunLifecycle(this.model) ? this.model.snapshot() : undefined;
  }

  private async emitRouteEvents(
    machine: RunMachine,
    eventSink: AgentEventSink | undefined,
  ): Promise<void> {
    if (!isModelProviderRunLifecycle(this.model)) return;
    for (const event of this.model.takeRouteEvents()) {
      if (event.type === 'selected') {
        await emit(machine, eventSink, {
          payload: {
            type: 'route.selected',
            model: event.model,
            mode: event.mode,
            tier: event.tier,
            reason: event.reason,
            candidates: event.candidates,
            actualModel: event.actualModel,
            phase: event.phase,
            phaseOverride: event.phaseOverride,
            suggestedModel: event.suggestedModel,
            excluded: event.excluded,
          },
        });
      } else if (event.type === 'fallback') {
        await emit(machine, eventSink, {
          payload: {
            type: 'route.fallback',
            fromModel: event.fromModel,
            toModel: event.toModel,
            reason: event.reason,
          },
        });
      } else {
        await emit(machine, eventSink, {
          payload: { type: 'route.fallback_rejected', model: event.model, reason: event.reason },
        });
      }
    }
  }

  private async emitNavigationEvent(machine: RunMachine, eventSink: AgentEventSink | undefined): Promise<void> {
    const hint = machine.navigationHint;
    await emit(machine, eventSink, {
      payload: {
        type: 'navigation.resolved',
        mode: this.options.navigationMode === 'off' ? 'off' : hint?.mode ?? 'none',
        confidence: hint?.confidence ?? 0,
        candidateCount: hint?.candidatePaths.length ?? 0,
        matched: Boolean(hint?.matches.length || hint?.candidatePaths.length),
      },
    });
  }

  private async applySteering(
    machine: RunMachine,
    itemId: (kind: string) => string,
    eventSink?: AgentEventSink,
  ): Promise<void> {
    const messages = await machine.takeSteering?.() ?? [];
    if (messages.length === 0) return;
    for (const message of messages) {
      machine.items.push(textMessage(itemId('steering'), 'user', message));
      machine.trace.push({ type: 'warning', message: '已应用用户 steering 指令' });
    }
    await this.saveCheckpoint(machine, eventSink);
  }

  private async executeTools(
    machine: RunMachine,
    calls: ToolCallItem[],
    runtimePermissions: ReadonlySet<Permission>,
    signal: AbortSignal | undefined,
    itemId: (kind: string) => string,
    eventSink?: AgentEventSink,
  ): Promise<'ok' | 'cancelled' | 'budget_exhausted' | 'approval_required' | 'verification_failed'> {
    const scheduled = await this.toolScheduler.execute(
      calls,
      this.registry,
      (call) => this.executeOneTool(
        machine,
        call,
        runtimePermissions,
        signal,
        itemId,
        eventSink,
      ),
      this.model.capabilities.supportsParallelToolCalls,
    );
    // 调度器已按 callIndex 排序（tool-scheduler.execute）且同批完成后再统一写回，
    // 因此并行工具完成顺序即使不同，写回顺序也与模型看到的工具调用顺序一致，
    // 保证下一轮 Provider 消息稳定；副作用工具不会与其他写操作交叉。
    const changedFiles = new Set<string>();
    let hasSuccessfulWrite = false;
    for (const { value } of scheduled) {
      // 清除历史里等待审批写入的占位结果：用户批准后该工具必须真正执行，
      // 占位结果不删会导致同一次调用出现两条 tool_result。
      machine.items = machine.items.filter((item) => !(item.type === 'tool_result'
        && item.callId === value.call.callId
        && item.error?.code === 'approval_required'));
      machine.items.push(value.item);
      machine.trace.push({ type: 'tool', message: `${value.call.name}: ${value.result.summary}` });
      if (this.registry.list().some((tool) => tool.name === value.call.name && tool.effect === 'write')
        && value.result.status === 'ok') {
        hasSuccessfulWrite = true;
        const data = value.result.data && typeof value.result.data === 'object'
          ? value.result.data as Record<string, unknown> : {};
        if (Array.isArray(data.changedFiles)) {
          for (const file of data.changedFiles) if (typeof file === 'string') changedFiles.add(file);
        }
      }
    }
    let verificationStop: 'cancelled' | 'budget_exhausted' | 'approval_required' | 'verification_failed' | undefined;
    if (hasSuccessfulWrite) {
      const verificationResult = await this.runAutomaticVerification(
        machine, [...changedFiles], runtimePermissions, signal, itemId, eventSink,
      );
      if (verificationResult !== 'continue') verificationStop = verificationResult;
    }
    await this.saveCheckpoint(machine, eventSink);
    if (scheduled.some(({ value }) => value.result.status === 'cancelled')) return 'cancelled';
    if (scheduled.some(({ value }) => value.result.error?.code === 'approval_required')) {
      return 'approval_required';
    }
    if (scheduled.some(({ value }) => value.result.error?.code === 'budget_exhausted')) {
      return 'budget_exhausted';
    }
    if (verificationStop) return verificationStop;
    return 'ok';
  }

  private async runAutomaticVerification(
    machine: RunMachine,
    changedFiles: string[],
    runtimePermissions: ReadonlySet<Permission>,
    signal: AbortSignal | undefined,
    itemId: (kind: string) => string,
    eventSink?: AgentEventSink,
  ): Promise<'continue' | 'cancelled' | 'budget_exhausted' | 'approval_required' | 'verification_failed'> {
    const gate = this.options.verificationGate ?? 'off';
    if (gate === 'off') return 'continue';
    const planned = machine.approvedPlan?.steps.some((step) => step.verification.trim().length > 0) ?? false;
    if (!changedFiles.length && !planned) return 'continue';

    const skip = async (reason: string, shouldPause: boolean): Promise<'continue' | 'verification_failed'> => {
      await emit(machine, eventSink, {
        payload: { type: 'verification.skipped', reason, changedFiles },
      });
      return shouldPause ? 'verification_failed' : 'continue';
    };
    if (!this.registry.list().some((tool) => tool.name === 'verify_changes')) {
      return skip('未注册 Sandbox 验证工具', gate === 'strict');
    }
    if (!runtimePermissions.has('process.exec')) {
      return skip('Runtime 未授予 Sandbox 命令执行权限', gate === 'strict');
    }

    const plan = await selectVerificationPlan(this.options.workspaceRoot, changedFiles);
    if (plan.commands.length === 0) return skip(plan.reason, false);
    await emit(machine, eventSink, {
      payload: {
        type: 'verification.started',
        changedFiles,
        commands: plan.commands.map((command) => command.id),
      },
    });
    const call: ToolCallItem = {
      type: 'tool_call',
      id: itemId('verification-call'),
      callId: `${machine.runId}:verify:${machine.step}:${machine.items.length}`,
      name: 'verify_changes',
      arguments: { changedFiles },
      callIndex: 0,
    };
    machine.internalVerificationCallIds.add(call.callId);
    machine.items.push(call);
    // Persist the internal call before starting Sandbox work. A crash can then either
    // resume this exact authorized verifier call or merge its completed result safely.
    await this.saveCheckpoint(machine, eventSink);
    const invoked = await this.executeOneTool(
      machine, call, runtimePermissions, signal, itemId, eventSink,
    );
    machine.internalVerificationCallIds.delete(call.callId);
    machine.items.push(invoked.item);
    machine.trace.push({ type: 'tool', message: `verify_changes: ${invoked.result.summary}` });
    if (invoked.result.error?.code === 'budget_exhausted') return 'budget_exhausted';
    if (invoked.result.error?.code === 'approval_required') return 'approval_required';
    if (invoked.result.status === 'cancelled') return 'cancelled';
    const results = verificationResults(invoked.result.data);
    const unavailable = results.some((result) => result.reason === 'sandbox_unavailable');
    if (unavailable) {
      return skip('Sandbox 不可用，验证未运行', gate === 'strict');
    }
    const verified = invoked.result.status === 'ok'
      && results.length > 0
      && results.every((result) => result.status === 'passed');
    await emit(machine, eventSink, {
      payload: {
        type: 'verification.completed',
        verified,
        issueCount: verified ? 0 : Math.max(1, results.filter((result) => result.status !== 'passed').length),
        results,
      },
    });
    if (verified) return 'continue';

    const consecutiveFailures = consecutiveVerificationFailures(machine.items);
    return consecutiveFailures >= 2 ? 'verification_failed' : 'continue';
  }

  private async executeOneTool(
    machine: RunMachine,
    call: ToolCallItem,
    runtimePermissions: ReadonlySet<Permission>,
    signal: AbortSignal | undefined,
    itemId: (kind: string) => string,
    eventSink?: AgentEventSink,
  ): Promise<{ call: ToolCallItem; result: ToolResult; item: ToolResultItem }> {
    const prepared = await this.contextManager.build(machine.items, {
      privacy: this.options.privacy ?? 'full-context',
      providerMaxContextTokens: this.model.capabilities.maxContextTokens,
      runtimePermissions,
      targetPath: typeof call.arguments.path === 'string'
        ? call.arguments.path : this.options.instructionTarget,
      hookContexts: machine.hookContexts,
      activeSkills: machine.activeSkills,
      gitHistoryPaths: typeof call.arguments.path === 'string' ? [call.arguments.path] : [],
    });
    // 工具可执行的权限完全来自 ContextManager 构建的权限规则；
    // 工具输出/MCP 内容只能作为不可信证据回填，不能反向修改权限集合或 System Policy。
    const context: ToolContext = {
      workspaceRoot: this.options.workspaceRoot,
      internalOperation: call.name === 'verify_changes' && machine.internalVerificationCallIds.has(call.callId)
        ? 'automatic_verification' : undefined,
      allowedPermissions: new Set(prepared.permissions.effectivePermissions),
      permissionProfile: this.options.permissionProfile,
      approvalRequiredPermissions: new Set(
        prepared.permissions.approvalRequests.map((request) => request.permission),
      ),
      signal: signal ?? new AbortController().signal,
      approvalContext: {
        sessionId: machine.sessionId,
        turnId: machine.turnId,
        runId: machine.runId,
        callId: call.callId,
      },
      reportProgress: (progress) => {
        void emit(machine, eventSink, {
          payload: {
            type: 'tool.progress',
            callId: call.callId,
            toolName: call.name,
            progress: progress.value,
            total: progress.total,
          },
        });
      },
    };
    let started = performance.now();
    const outcome = await this.executor.invokeWithDecision(
      call.name,
      call.arguments,
      context,
      async (decision) => {
        await emit(machine, eventSink, {
          payload: {
            type: 'guardrail.decision',
            target: 'proposed_action',
            decision: decision.decision,
            reasonCode: decision.reasonCode,
            callId: call.callId,
          },
        });
        if (decision.reasonCode === 'approval_granted' || decision.reasonCode === 'approval_denied') {
          await emit(machine, eventSink, {
            payload: {
              type: 'approval.decided',
              approvalId: `${machine.runId}:${call.callId}`,
              decision: decision.reasonCode === 'approval_granted' ? 'allow' : 'deny',
              scope: 'once',
            },
          });
        }
        if (decision.decision === 'allow') {
          started = performance.now();
          await emit(machine, eventSink, {
            payload: {
              type: 'tool.started',
              callId: call.callId,
              toolName: call.name,
              callIndex: call.callIndex,
            },
          });
        }
      },
      async (request) => {
        await emit(machine, eventSink, {
          payload: {
            type: 'approval.requested',
            approvalId: request.id,
            callId: call.callId,
            permission: this.registry.get(call.name).permission,
            reasonCode: request.reasonCode,
          },
        });
      },
      async (tool, validatedArguments) => {
        const hookResult = await this.runCommandHooks(machine, eventSink, {
          version: 1,
          hookEventName: 'PreToolUse',
          sessionId: machine.sessionId,
          turnId: machine.turnId,
          runId: machine.runId,
          cwd: this.options.workspaceRoot,
          callId: call.callId,
          toolName: tool.name,
          permission: tool.permission,
          effect: tool.effect ?? (tool.permission === 'workspace.read' ? 'read' : 'external'),
          toolInput: structuredClone(validatedArguments),
        }, context.signal);
        return hookResult.decision === 'deny'
          ? { decision: 'deny', reason: hookResult.reason ?? 'Hook 拒绝了工具调用' }
          : undefined;
      },
    );
    const result = outcome.result;
    const item = toolResultItem(call, result, itemId);
    const completedTool = this.registry.list().find((tool) => tool.name === call.name);
    const outputDecision = toolOutputGuardrailDecision(result);
    await emit(machine, eventSink, {
      payload: {
        type: 'guardrail.decision',
        target: 'tool_output',
        decision: outputDecision.decision,
        reasonCode: outputDecision.reasonCode,
        callId: call.callId,
      },
    });
    await emit(machine, eventSink, {
      payload: {
        type: 'tool.completed',
        callId: call.callId,
        toolName: call.name,
        callIndex: call.callIndex,
        status: result.status,
        elapsedMs: Math.max(0, Math.round(performance.now() - started)),
        evidenceIds: result.evidenceIds,
        result: item,
      },
    });
    await this.runCommandHooks(machine, eventSink, {
      version: 1,
      hookEventName: 'PostToolUse',
      sessionId: machine.sessionId,
      turnId: machine.turnId,
      runId: machine.runId,
      cwd: this.options.workspaceRoot,
      callId: call.callId,
      toolName: call.name,
      permission: completedTool?.permission,
      effect: completedTool?.effect
        ?? (completedTool?.permission === 'workspace.read' ? 'read' : 'external'),
      toolInput: structuredClone(outcome.decision.normalizedArguments),
      toolResult: structuredClone(result),
    }, context.signal);
    const observation = result.status === 'ok'
      ? workspaceFileObservation(
          this.registry,
          call,
          outcome.decision.normalizedArguments,
          result.evidenceIds,
        )
      : undefined;
    if (observation) await emit(machine, eventSink, { payload: observation });
    return { call, result, item };
  }

  private async saveCheckpoint(
    machine: RunMachine,
    eventSink?: AgentEventSink,
    state: RunState = 'running',
  ): Promise<AgentCheckpoint> {
    const checkpoint: AgentCheckpoint = {
      version: 1,
      sessionId: machine.sessionId,
      turnId: machine.turnId,
      runId: machine.runId,
      step: machine.step,
      phase: machine.phase,
      toolCallsUsed: this.executor.callsUsed(),
      internalVerificationCallIds: [...machine.internalVerificationCallIds],
      state,
      items: structuredClone(machine.items),
      hookContexts: structuredClone(machine.hookContexts),
      routing: isModelProviderRunLifecycle(this.model) ? this.model.snapshot() : undefined,
    };
    const event = await emit(machine, eventSink, {
      payload: { type: 'checkpoint.saved', checkpoint },
    });
    if (event?.payload.type === 'checkpoint.saved') return event.payload.checkpoint;
    return checkpoint;
  }

  private async pause(
    machine: RunMachine,
    eventSink: AgentEventSink | undefined,
    reason: 'step_budget' | 'tool_budget' | 'approval_required' | 'verification_failed' | 'user_paused',
  ): Promise<AgentRunResult> {
    const checkpoint = await this.saveCheckpoint(machine, eventSink, 'paused');
    await emit(machine, eventSink, { payload: { type: 'run.paused', reason } });
    await this.runStopHooks(machine, eventSink, 'paused', true, 'Agent 已暂停，可从当前检查点继续。');
    return finishRun('Agent 已暂停，可从当前检查点继续。', machine, true, 'paused', checkpoint);
  }

  private async cancel(
    machine: RunMachine,
    eventSink: AgentEventSink | undefined,
    reason: unknown,
  ): Promise<AgentRunResult> {
    const checkpoint = await this.saveCheckpoint(machine, eventSink, 'cancelled');
    await emit(machine, eventSink, {
      payload: { type: 'run.cancelled', reason: safeReason(reason) },
    });
    await this.runStopHooks(machine, eventSink, 'cancelled', true, '当前 Turn 已取消，可稍后恢复。');
    return finishRun('当前 Turn 已取消，可稍后恢复。', machine, true, 'cancelled', checkpoint);
  }

  private async fail(
    machine: RunMachine,
    eventSink: AgentEventSink | undefined,
    code: string,
    answer: string,
  ): Promise<AgentRunResult> {
    machine.phase = 'finished';
    const checkpoint = await this.saveCheckpoint(machine, eventSink, 'failed');
    await emit(machine, eventSink, { payload: { type: 'run.failed', code, retryable: false } });
    await this.runStopHooks(machine, eventSink, 'failed', true, answer);
    return finishRun(answer, machine, true, 'failed', checkpoint);
  }

  private async finish(
    machine: RunMachine,
    rawAnswer: string,
    degraded: boolean,
    state: Extract<RunState, 'completed' | 'cancelled' | 'failed'>,
    eventSink?: AgentEventSink,
  ): Promise<AgentRunResult> {
    machine.phase = 'finished';
    const checkpoint = await this.saveCheckpoint(machine, eventSink, state);
    const parsed = parseFinalSummary(rawAnswer);
    let proposedPlan: AgentRunResult['proposedPlan'];
    if (machine.lastResponsePhase === 'plan' && rawAnswer.trim()) {
      const planId = `${machine.runId}:plan`;
      const plan = parseAgentPlan(rawAnswer);
      proposedPlan = plan.verified ? { planId, plan: plan.value } : { planId, raw: rawAnswer };
      await emit(machine, eventSink, { payload: { type: 'plan.proposed', ...proposedPlan } });
    } else {
      await emit(machine, eventSink, {
        payload: {
          type: 'verification.completed',
          verified: parsed.verified,
          issueCount: parsed.verified ? parsed.value.unresolved.length : 1,
        },
      });
    }
    await emit(machine, eventSink, {
      payload: { type: 'run.completed', answer: rawAnswer, degraded },
    });
    await this.runStopHooks(machine, eventSink, state, degraded, rawAnswer);
    return finishRun(rawAnswer, machine, degraded, state, checkpoint, parsed, proposedPlan);
  }

  private async runStopHooks(
    machine: RunMachine,
    eventSink: AgentEventSink | undefined,
    state: RunState,
    degraded: boolean,
    answer: string,
  ): Promise<void> {
    await this.runCommandHooks(machine, eventSink, {
      version: 1,
      hookEventName: 'Stop',
      sessionId: machine.sessionId,
      turnId: machine.turnId,
      runId: machine.runId,
      cwd: this.options.workspaceRoot,
      state,
      degraded,
      answer,
    });
  }

  private async runCommandHooks(
    machine: RunMachine,
    eventSink: AgentEventSink | undefined,
    input: import('../orchestration/command-hooks.js').HookInput,
    signal?: AbortSignal,
  ): Promise<import('../orchestration/command-hooks.js').HookRunResult> {
    const outcome = await machine.hooks?.run(input, signal)
      ?? { decision: 'continue' as const, contexts: [], results: [] };
    for (const result of outcome.results) {
      await emit(machine, eventSink, {
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
    return outcome;
  }
}

function verificationResults(data: unknown): EditVerificationResult[] {
  if (!data || typeof data !== 'object' || !Array.isArray((data as { verification?: unknown }).verification)) return [];
  return (data as { verification: EditVerificationResult[] }).verification;
}

function consecutiveVerificationFailures(items: readonly ConversationItem[]): number {
  let count = 0;
  for (const item of [...items].reverse()) {
    if (item.type !== 'tool_result' || item.toolName !== 'verify_changes') continue;
    if (item.error?.code !== 'verification_failed') break;
    count += 1;
  }
  return count;
}

function pendingAutomaticVerificationCallIds(
  items: readonly ConversationItem[],
  callIds: readonly string[],
): Set<string> {
  const calls = new Set(items.filter(isToolCallItem)
    .filter((call) => call.name === 'verify_changes')
    .map((call) => call.callId));
  const results = new Set(items.filter((item): item is ToolResultItem => item.type === 'tool_result')
    .map((item) => item.callId));
  return new Set(callIds.filter((callId) => calls.has(callId) && !results.has(callId)));
}

function workspaceFileObservation(
  registry: ToolRegistry,
  call: ToolCallItem,
  arguments_: Record<string, unknown>,
  evidenceIds: string[],
): Extract<AgentEventIntent['payload'], { type: 'workspace.file.observed' }> | undefined {
  let observation: ToolSpec['observation'];
  try {
    observation = registry.get(call.name).observation;
  } catch {
    return undefined;
  }
  if (observation?.type !== 'workspace.file') return undefined;
  return {
    type: 'workspace.file.observed',
    operation: observation.operation,
    path: typeof arguments_.path === 'string' ? arguments_.path : '.',
    evidenceIds: [...evidenceIds],
    callId: call.callId,
  };
}

function toolResultItem(
  call: ToolCallItem,
  result: ToolResult,
  itemId: (kind: string) => string,
): ToolResultItem {
  return {
    type: 'tool_result',
    id: itemId('tool-result'),
    callId: call.callId,
    toolName: call.name,
    status: result.status,
    output: createToolOutputContextItem(itemId('context'), call, result),
    summary: result.summary,
    data: result.data,
    error: result.error,
    outputMetadata: result.outputMetadata,
    evidenceIds: result.evidenceIds,
  };
}

// 恢复时按 callId 去重：已存在非 approval_required 结果的工具视为完成，不再重新执行。
// approval_required 工具不算完成，因为用户批准后该工具需要真正执行一次。
function pendingToolCalls(items: readonly ConversationItem[]): ToolCallItem[] {
  const completed = new Set(items
    .filter((item): item is ToolResultItem => item.type === 'tool_result')
    .filter((item) => item.error?.code !== 'approval_required')
    .map((item) => item.callId));
  const lastMessage = items.findLastIndex((item) => item.type === 'message');
  return items.slice(lastMessage + 1)
    .filter(isToolCallItem)
    .filter((call) => !completed.has(call.callId));
}

function providerTools(
  model: ModelProvider,
  registry: ToolRegistry,
  permissions: ReadonlySet<Permission>,
  readOnly = false,
): ModelToolDefinition[] | undefined {
  if (!model.capabilities.supportsToolCalls) return undefined;
  const tools = registry.list().filter((tool) => permissions.has(tool.permission))
    .filter((tool) => !readOnly || (tool.effect ?? (tool.permission === 'workspace.read' ? 'read' : 'external')) === 'read')
    .map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.inputSchema,
  }));
  return tools.length > 0 ? tools : undefined;
}

function requestToolChoice(
  model: ModelProvider,
  navigationHint: NavigationHint | undefined,
  discovery: boolean,
  tools: ModelToolDefinition[] | undefined,
): ToolChoice | undefined {
  if (!tools?.length || model.capabilities.supportsToolChoice === false) return undefined;
  if (!discovery || !navigationHint) return 'auto';
  return navigationHint.mode === 'advisory' ? 'auto' : 'required';
}

function hasToolResultInCurrentTurn(items: readonly ConversationItem[]): boolean {
  const currentTurnStart = items.findLastIndex((item) => item.type === 'message' && item.role === 'user');
  return items.slice(currentTurnStart + 1).some((item) => item.type === 'tool_result');
}

function latestUserText(items: readonly ConversationItem[]): string {
  const message = items.findLast((item) => item.type === 'message' && item.role === 'user');
  return message && isMessageItem(message) ? messageText(message) : '';
}

function effectiveRuntimePermissions(
  configured: ReadonlySet<Permission>,
  model: ModelProvider,
): ReadonlySet<Permission> {
  if (!isModelProviderRunLifecycle(model)) return configured;
  const ceiling = model.allowedPermissions();
  if (!ceiling) return configured;
  return new Set([...configured].filter((permission) => ceiling.has(permission)));
}

function assistantText(items: readonly ConversationItem[]): string {
  return items.filter(isMessageItem)
    .filter((item) => item.role === 'assistant')
    .map(messageText)
    .join('');
}

function finishRun(
  rawAnswer: string,
  machine: RunMachine,
  degraded: boolean,
  state: RunState,
  checkpoint: AgentCheckpoint,
  finalSummary: StructuredOutputResult<FinalSummary> = parseFinalSummary(rawAnswer),
  proposedPlan?: AgentRunResult['proposedPlan'],
): AgentRunResult {
  return {
    answer: finalSummary.verified ? finalSummary.value.answer : rawAnswer,
    items: machine.items,
    trace: machine.trace,
    degraded,
    state,
    sessionId: machine.sessionId,
    turnId: machine.turnId,
    runId: machine.runId,
    checkpoint,
    finalSummary,
    proposedPlan,
  };
}

function itemIdFactory(runId: string, offset: number): (kind: string) => string {
  let next = offset;
  return (kind) => `${runId}:${kind}:${next += 1}`;
}

// 整个 run 的所有事件都经同一个 sink 串行 append（单写者），由 sink 维护递增 seq。
// 未挂 sink 时退化为内存事件并固定 seq=0，此时仅用于回调观察，不承诺持久化顺序。
async function emit(
  machine: RunMachine,
  sink: AgentEventSink | undefined,
  intent: Omit<AgentEventIntent, 'turnId' | 'runId' | 'parentEventId'>,
): Promise<AgentEvent | undefined> {
  if (!sink && !machine.onEvent) return undefined;
  const event = sink
    ? await sink.append({
        ...intent,
        turnId: machine.turnId,
        runId: machine.runId,
        parentEventId: machine.parentEventId,
      })
    : {
        version: 1 as const,
        eventId: randomUUID(),
        sessionId: machine.sessionId,
        turnId: machine.turnId,
        runId: machine.runId,
        seq: 0,
        timestamp: new Date().toISOString(),
        parentEventId: machine.parentEventId,
        payload: intent.payload,
      };
  machine.parentEventId = event.eventId;
  await machine.onEvent?.(event);
  await machine.hooks?.observe(event);
  return event;
}

function stopReasonMessage(reason: string): string {
  const messages: Record<string, string> = {
    tool_calls: '模型声明了工具调用，但没有返回可执行的工具请求。',
    truncated: '模型输出因长度限制而未完成。',
    blocked: '模型输出被内容策略阻止。',
    cancelled: '模型请求已取消。',
    retryable_error: '模型服务暂时不可用，可稍后重试。',
    fatal_error: '模型服务返回不可恢复错误。',
  };
  return messages[reason] ?? `模型未正常完成：${reason}`;
}

function errorCode(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') {
    return error.code;
  }
  return 'model_failed';
}

function errorRetryable(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'retryable' in error && error.retryable === true);
}

function safeReason(reason: unknown): string {
  return reason instanceof Error ? reason.name : typeof reason === 'string' ? reason : 'cancelled';
}

function latestInstructionTarget(
  items: readonly ConversationItem[],
  fallback?: string,
): string | undefined {
  const call = items.findLast((item) => item.type === 'tool_call'
    && typeof item.arguments.path === 'string');
  return call?.type === 'tool_call' && typeof call.arguments.path === 'string'
    ? call.arguments.path
    : fallback;
}

function uniquePaths(paths: readonly string[]): string[] {
  return [...new Set(paths.map((value) => value.trim()).filter(Boolean))].slice(0, 8);
}
