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
      items: [
        systemPolicyMessage(),
        ...history.filter((item) => item.type !== 'message' || item.role !== 'system'),
        textMessage(itemId('message'), 'user', userMessage),
      ],
      trace: [],
      onEvent: runtime.onEvent,
      takeSteering: runtime.takeSteering,
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
    };
    this.executor.restoreBudget(checkpoint.toolCallsUsed);
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
    const itemId = itemIdFactory(machine.runId, machine.items.length);
    const tools = providerTools(this.model, this.registry);
    const runtimePermissions = this.options.permissions ?? new Set<Permission>(['workspace.read']);

    while (machine.step < (this.options.maxSteps ?? 8)) {
      if (signal?.aborted) return this.cancel(machine, eventSink, signal.reason);

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
    for (const { value } of scheduled) {
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
            request,
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
