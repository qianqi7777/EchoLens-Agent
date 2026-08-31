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
} from '../context/context-manager.js';
import type {
  ModelProvider,
  ModelToolDefinition,
  ProviderRequest,
  ProviderResult,
} from '../providers/types.js';
import type {
  AgentCheckpoint,
  AgentEvent,
  AgentEventIntent,
  AgentEventSink,
  RunState,
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
  parseFinalSummary,
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
}

export interface AgentRunRuntime {
  sessionId?: string;
  turnId?: string;
  eventSink?: AgentEventSink;
  onEvent?: (event: AgentEvent) => void | Promise<void>;
  takeSteering?: () => Promise<string[]>;
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
}

/** 显式、可检查点恢复的 model -> tools -> model 状态机。 */
export class ReactAgent {
  private readonly contextManager: ContextManager;
  private readonly toolScheduler: ToolScheduler;

  constructor(
    private readonly model: ModelProvider,
    private readonly registry: ToolRegistry,
    private readonly executor: ToolExecutor,
    private readonly options: ReactAgentOptions,
  ) {
    this.contextManager = options.contextManager ?? new ContextManager({
      workspaceRoot: options.workspaceRoot,
      maxHistoryTurns: options.maxHistoryTurns,
    });
    this.toolScheduler = options.toolScheduler ?? new ToolScheduler();
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
    };
    this.executor.resetBudget();
    await emit(machine, runtime.eventSink, { payload: { type: 'turn.started', userMessage } });
    await emit(machine, runtime.eventSink, {
      payload: { type: 'run.started', model: this.model.model, resumed: false },
    });
    await this.saveCheckpoint(machine, runtime.eventSink);
    return this.execute(machine, signal, runtime.eventSink);
  }

  async resume(
    checkpoint: AgentCheckpoint,
    signal?: AbortSignal,
    runtime: AgentRunRuntime = {},
  ): Promise<AgentRunResult> {
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
    };
    // A resume is an explicit request for another bounded execution slice.
    // Completed tool results stay in the checkpoint, while runtime budgets are
    // refreshed so step/tool budget pauses can actually make progress.
    this.executor.resetBudget();
    await emit(machine, runtime.eventSink, {
      payload: { type: 'run.started', model: this.model.model, resumed: true },
    });
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
    const tools = providerTools(this.model, this.registry);
    const runtimePermissions = this.options.permissions ?? new Set<Permission>(['workspace.read']);

    // stepLimit 从 checkpoint 步数起算而非从 0 计数：恢复后的每个新片段都只获得
    // 一份 maxSteps 预算，已耗步数不重复计，因此不会因多次恢复而无限延长执行。
    const stepLimit = machine.step + (this.options.maxSteps ?? 8);
    while (machine.step < stepLimit) {
      if (signal?.aborted) return this.cancel(machine, eventSink, signal.reason);

      // tools 阶段先执行所有挂起工具；执行结果决定继续、暂停还是取消。
      if (machine.phase === 'tools') {
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
        machine.phase = 'model';
        machine.step += 1;
        await this.saveCheckpoint(machine, eventSink);
        continue;
      }

      await this.applySteering(machine, itemId, eventSink);

      await emit(machine, eventSink, { payload: { type: 'model.started', step: machine.step } });
      let response;
      try {
        const prepared = await this.contextManager.build(machine.items, {
          privacy: this.options.privacy ?? 'full-context',
          providerMaxContextTokens: this.model.capabilities.maxContextTokens,
          runtimePermissions,
          targetPath: latestInstructionTarget(machine.items, this.options.instructionTarget),
        });
        response = await this.completeModel(machine, eventSink, {
          items: prepared.items,
          tools,
          responseFormat: this.model.capabilities.supportsStructuredOutput
            ? FINAL_SUMMARY_FORMAT
            : undefined,
          signal,
        });
      } catch (error) {
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
  ): Promise<'ok' | 'cancelled' | 'budget_exhausted' | 'approval_required'> {
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
    for (const { value } of scheduled) {
      // 清除历史里等待审批写入的占位结果：用户批准后该工具必须真正执行，
      // 占位结果不删会导致同一次调用出现两条 tool_result。
      machine.items = machine.items.filter((item) => !(item.type === 'tool_result'
        && item.callId === value.call.callId
        && item.error?.code === 'approval_required'));
      machine.items.push(value.item);
      machine.trace.push({ type: 'tool', message: `${value.call.name}: ${value.result.summary}` });
    }
    await this.saveCheckpoint(machine, eventSink);
    if (scheduled.some(({ value }) => value.result.status === 'cancelled')) return 'cancelled';
    if (scheduled.some(({ value }) => value.result.error?.code === 'approval_required')) {
      return 'approval_required';
    }
    if (scheduled.some(({ value }) => value.result.error?.code === 'budget_exhausted')) {
      return 'budget_exhausted';
    }
    return 'ok';
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
    });
    // 工具可执行的权限完全来自 ContextManager 构建的权限规则；
    // 工具输出/MCP 内容只能作为不可信证据回填，不能反向修改权限集合或 System Policy。
    const context: ToolContext = {
      workspaceRoot: this.options.workspaceRoot,
      allowedPermissions: new Set(prepared.permissions.effectivePermissions),
      approvalRequiredPermissions: new Set(
        prepared.permissions.approvalRequests.map((request) => request.permission),
      ),
      signal: signal ?? new AbortController().signal,
      approvalContext: {
        sessionId: machine.sessionId,
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
    );
    const result = outcome.result;
    const item = toolResultItem(call, result, itemId);
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
      state,
      items: structuredClone(machine.items),
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
    reason: 'step_budget' | 'tool_budget' | 'approval_required',
  ): Promise<AgentRunResult> {
    const checkpoint = await this.saveCheckpoint(machine, eventSink, 'paused');
    await emit(machine, eventSink, { payload: { type: 'run.paused', reason } });
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
    return finishRun('当前 Turn 已取消，可稍后恢复。', machine, true, 'cancelled', checkpoint);
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
    await emit(machine, eventSink, {
      payload: {
        type: 'verification.completed',
        verified: parsed.verified,
        issueCount: parsed.verified ? parsed.value.unresolved.length : 1,
      },
    });
    await emit(machine, eventSink, {
      payload: { type: 'run.completed', answer: rawAnswer, degraded },
    });
    return finishRun(rawAnswer, machine, degraded, state, checkpoint, parsed);
  }
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

function providerTools(model: ModelProvider, registry: ToolRegistry): ModelToolDefinition[] | undefined {
  if (!model.capabilities.supportsToolCalls) return undefined;
  const tools = registry.list().map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.inputSchema,
  }));
  return tools.length > 0 ? tools : undefined;
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
