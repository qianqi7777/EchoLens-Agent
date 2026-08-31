import { randomUUID } from 'node:crypto';
import type { ConversationItem } from '../core/messages.js';
import type { AgentRunResult, ReactAgent } from '../runtime/react-loop.js';
import type { AgentCheckpoint, AgentEvent } from './events.js';
import { JsonlEventStore, type JsonlEventStoreOptions } from './jsonl-event-store.js';
import type { LifecycleHookRunner } from '../orchestration/lifecycle-hooks.js';

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

  private constructor(
    private readonly agent: ReactAgent,
    store: JsonlEventStore,
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
    const runtime = new SessionRuntime(agent, store);
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
      runtime.history = recoverCheckpoint(events)?.items ?? [];
      runtime.steeringQueue = pendingSteering(events);
    }
    return runtime;
  }

  async run(
    userMessage: string,
    signal?: AbortSignal,
    onEvent?: (event: AgentEvent) => void | Promise<void>,
  ): Promise<AgentRunResult> {
    const turnId = randomUUID();
    this.activeTurnId = turnId;
    try {
      const result = await this.agent.run(userMessage, this.history, signal, {
        sessionId: this.sessionId,
        turnId,
        eventSink: this.store,
        onEvent,
        takeSteering: () => this.takeSteering(),
      });
      this.history = result.items;
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
      const result = await this.agent.resume(checkpoint, signal, {
        sessionId: this.sessionId,
        eventSink: this.store,
        onEvent,
        takeSteering: () => this.takeSteering(),
      });
      this.history = result.items;
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
    this.steeringQueue.push(normalized);
    await this.store.append({
      turnId,
      runId: checkpoint?.runId,
      payload: { type: 'turn.steered', message: normalized },
    });
  }

  conversation(): ConversationItem[] {
    return structuredClone(this.history);
  }

  close(): Promise<void> {
    return this.store.close();
  }

  private async takeSteering(): Promise<string[]> {
    return this.steeringQueue.splice(0, this.steeringQueue.length);
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

function callIndex(checkpoint: AgentCheckpoint, callId: string): number {
  const call = checkpoint.items.find((item) => item.type === 'tool_call' && item.callId === callId);
  return call?.type === 'tool_call' ? call.callIndex : Number.MAX_SAFE_INTEGER;
}

// 这些错误码代表工具未真正执行（被拒、预算耗尽、未知工具、参数无效），不计入预算。
function countsAgainstBudget(result: ConversationItem & { type: 'tool_result' }): boolean {
  return ![
    'approval_required',
    'permission_denied',
    'budget_exhausted',
    'unknown_tool',
    'invalid_arguments',
  ].includes(result.error?.code ?? '');
}
