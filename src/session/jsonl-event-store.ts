import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir, stat, truncate, type FileHandle } from 'node:fs/promises';
import { resolve } from 'node:path';
import { redactValueWithReport } from '../providers/redaction.js';
import { acquireFileLock, type FileLock } from '../runtime/file-lock.js';
import {
  AGENT_EVENT_VERSION,
  type AgentEvent,
  type AgentEventIntent,
  type AgentEventPayload,
  type AgentEventSink,
} from './events.js';

// sessionId 会直接拼入事件文件路径，限定为安全文件名字符集，避免路径穿越。
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
// 恢复阶段读取文件的硬上限；损坏或异常的巨型文件不会在恢复时耗尽内存。
const MAX_EVENT_FILE_BYTES = 64 * 1024 * 1024;

export interface JsonlEventStoreOptions {
  flushEachEvent?: boolean;
  now?: () => Date;
  eventId?: () => string;
  lockTimeoutMs?: number;
}

export interface SessionDescriptor {
  sessionId: string;
  bytes: number;
  modifiedAt: string;
}

// 稳定错误码 event_store_corrupt：调用方可以将存储损坏与普通 IO 错误区分开。
export class EventStoreCorruptionError extends Error {
  readonly code = 'event_store_corrupt';

  constructor(message: string) {
    super(message);
    this.name = 'EventStoreCorruptionError';
  }
}

export class JsonlEventStore implements AgentEventSink {
  readonly sessionId: string;
  readonly filePath: string;
  private readonly flushEachEvent: boolean;
  private readonly now: () => Date;
  private readonly createEventId: () => string;
  private readonly lockTimeoutMs: number;
  private readonly ready: Promise<void>;
  private handle?: FileHandle;
  private lock?: FileLock;
  private writeQueue: Promise<unknown> = Promise.resolve();
  private lastSeq = 0;
  private closed = false;

  constructor(rootDirectory: string, sessionId: string, options: JsonlEventStoreOptions = {}) {
    if (!SESSION_ID_PATTERN.test(sessionId)) throw new Error('Session ID 格式无效');
    this.sessionId = sessionId;
    this.filePath = resolve(rootDirectory, `${sessionId}.jsonl`);
    this.flushEachEvent = options.flushEachEvent ?? true;
    this.now = options.now ?? (() => new Date());
    this.createEventId = options.eventId ?? randomUUID;
    this.lockTimeoutMs = options.lockTimeoutMs ?? 0;
    this.ready = this.initialize(rootDirectory);
  }

  // 所有写入经 writeQueue 链式串行：同一时刻仅一个写者分配 seq 并落盘，保证 seq 严格单调；
  // createEventId() 在队列内调用，使并发请求的 eventId 顺序与落盘顺序一致。
  append(intent: AgentEventIntent): Promise<AgentEvent> {
    const operation = this.writeQueue.then(async () => {
      await this.ready;
      if (this.closed || !this.handle) throw new Error('Event Store 已关闭');
      const event: AgentEvent = {
        version: AGENT_EVENT_VERSION,
        eventId: this.createEventId(),
        sessionId: this.sessionId,
        turnId: intent.turnId,
        runId: intent.runId,
        seq: this.lastSeq + 1,
        timestamp: this.now().toISOString(),
        parentEventId: intent.parentEventId,
        payload: sanitizePayload(intent.payload),
      };
      await this.handle.appendFile(`${JSON.stringify(event)}\n`, 'utf8');
      if (this.flushEachEvent || isDurableEvent(event.payload.type)) await this.handle.datasync();
      this.lastSeq = event.seq;
      return event;
    });
    this.writeQueue = operation;
    return operation;
  }

  async read(afterSeq = 0): Promise<AgentEvent[]> {
    await this.ready;
    await this.writeQueue;
    return readCompleteEvents(this.filePath).then((events) => events.filter((event) => event.seq > afterSeq));
  }

  async latestCheckpoint(): Promise<AgentEvent | undefined> {
    const events = await this.read();
    return events.findLast((event) => event.payload.type === 'checkpoint.saved');
  }

  async close(): Promise<void> {
    let failure: unknown;
    try {
      await this.writeQueue;
      await this.ready;
    } catch (error) {
      failure = error;
    } finally {
      this.closed = true;
      try {
        await this.handle?.datasync();
      } catch (error) {
        failure ??= error;
      }
      try {
        await this.handle?.close();
      } catch (error) {
        failure ??= error;
      }
      this.handle = undefined;
      try {
        await this.lock?.release();
      } catch (error) {
        failure ??= error;
      }
      this.lock = undefined;
    }
    if (failure) throw failure;
  }

  static async list(rootDirectory: string): Promise<SessionDescriptor[]> {
    try {
      const entries = await readdir(rootDirectory, { withFileTypes: true });
      const sessions = await Promise.all(entries
        .filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl'))
        .map(async (entry) => {
          const sessionId = entry.name.slice(0, -'.jsonl'.length);
          if (!SESSION_ID_PATTERN.test(sessionId)) return undefined;
          const info = await stat(resolve(rootDirectory, entry.name));
          return { sessionId, bytes: info.size, modifiedAt: info.mtime.toISOString() };
        }));
      return sessions.filter((item): item is SessionDescriptor => Boolean(item))
        .sort((left, right) => right.modifiedAt.localeCompare(left.modifiedAt));
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) return [];
      throw error;
    }
  }

  // 恢复必须先于任何 append：先截断损坏尾部、从完整事件序列得出 lastSeq，再打开写入句柄，
  // 避免恢复与写入交错产生新的不完整行。
  private async initialize(rootDirectory: string): Promise<void> {
    await mkdir(rootDirectory, { recursive: true });
    const lock = await acquireFileLock(`${this.filePath}.lock`, { timeoutMs: this.lockTimeoutMs });
    this.lock = lock;
    try {
      await recoverTail(this.filePath);
      const events = await readCompleteEvents(this.filePath);
      this.lastSeq = events.at(-1)?.seq ?? 0;
      this.handle = await open(this.filePath, 'a+');
    } catch (error) {
      this.lock = undefined;
      await lock.release().catch(() => undefined);
      throw error;
    }
  }
}

// 落盘边界统一脱敏：任何 payload 写入前都经 redactValueWithReport 过滤，
// 磁盘内容与恢复读取都不得保留工具输出中的敏感值。
function sanitizePayload(payload: AgentEventPayload): AgentEventPayload {
  return redactValueWithReport(payload).value as AgentEventPayload;
}

// 崩溃时 appendFile 可能只写入半行；恢复阶段截断最后一个不完整尾部，
// 保证重新打开后文件中只含完整事件。无换行结尾即视为未写完。
async function recoverTail(filePath: string): Promise<void> {
  let contents: Buffer;
  try {
    const info = await stat(filePath);
    if (info.size > MAX_EVENT_FILE_BYTES) throw new EventStoreCorruptionError('Event Store 超过恢复大小上限');
    contents = await readFile(filePath);
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return;
    throw error;
  }
  if (contents.length === 0) return;
  const lastNewline = contents.lastIndexOf(0x0a);
  const completeBytes = lastNewline < 0 ? 0 : lastNewline + 1;
  if (completeBytes < contents.length) await truncate(filePath, completeBytes);
}

// 读取与恢复共用同一套严格校验：seq 必须等于行号（1 起连续），空行、非 JSON 或结构
// 不合格的行一律抛 EventStoreCorruptionError，损坏日志绝不静默丢弃。
async function readCompleteEvents(filePath: string): Promise<AgentEvent[]> {
  let text: string;
  try {
    text = await readFile(filePath, 'utf8');
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return [];
    throw error;
  }
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  const events: AgentEvent[] = [];
  for (const [index, line] of lines.entries()) {
    if (!line) throw new EventStoreCorruptionError(`Event Store 第 ${index + 1} 行为空`);
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      throw new EventStoreCorruptionError(`Event Store 第 ${index + 1} 行不是合法 JSON`);
    }
    if (!isAgentEvent(value)) throw new EventStoreCorruptionError(`Event Store 第 ${index + 1} 行结构无效`);
    const expectedSeq = index + 1;
    if (value.seq !== expectedSeq) {
      throw new EventStoreCorruptionError(`Event Store seq 不连续：期望 ${expectedSeq}，实际 ${value.seq}`);
    }
    events.push(value);
  }
  return events;
}

function isAgentEvent(value: unknown): value is AgentEvent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const event = value as Partial<AgentEvent>;
  return event.version === AGENT_EVENT_VERSION
    && typeof event.eventId === 'string'
    && typeof event.sessionId === 'string'
    && Number.isInteger(event.seq)
    && (event.seq ?? 0) > 0
    && typeof event.timestamp === 'string'
    && Boolean(event.payload)
    && typeof event.payload === 'object'
    && typeof (event.payload as { type?: unknown }).type === 'string';
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === code;
}

// 这些事件代表不可重复的进度（检查点与各端到端运行状态），即使关闭逐条刷新也强制
// datasync 落盘；其余事件仅在 flushEachEvent 开启时刷新，减少常规写入的 fsync 开销。
function isDurableEvent(type: AgentEventPayload['type']): boolean {
  return type === 'checkpoint.saved'
    || type === 'run.completed'
    || type === 'run.paused'
    || type === 'run.cancelled'
    || type === 'run.failed';
}
