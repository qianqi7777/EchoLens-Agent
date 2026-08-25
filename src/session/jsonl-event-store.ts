import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir, stat, truncate, type FileHandle } from 'node:fs/promises';
import { resolve } from 'node:path';
import { redactValueWithReport } from '../providers/redaction.js';
import {
  AGENT_EVENT_VERSION,
  type AgentEvent,
  type AgentEventIntent,
  type AgentEventPayload,
  type AgentEventSink,
} from './events.js';

const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const MAX_EVENT_FILE_BYTES = 64 * 1024 * 1024;

export interface JsonlEventStoreOptions {
  flushEachEvent?: boolean;
  now?: () => Date;
  eventId?: () => string;
}

export interface SessionDescriptor {
  sessionId: string;
  bytes: number;
  modifiedAt: string;
}

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
  private readonly ready: Promise<void>;
  private handle?: FileHandle;
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
    this.ready = this.initialize(rootDirectory);
  }

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
    try {
      await this.writeQueue;
      await this.ready;
    } finally {
      this.closed = true;
      await this.handle?.datasync();
      await this.handle?.close();
      this.handle = undefined;
    }
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

  private async initialize(rootDirectory: string): Promise<void> {
    await mkdir(rootDirectory, { recursive: true });
    await recoverTail(this.filePath);
    const events = await readCompleteEvents(this.filePath);
    this.lastSeq = events.at(-1)?.seq ?? 0;
    this.handle = await open(this.filePath, 'a+');
  }
}

function sanitizePayload(payload: AgentEventPayload): AgentEventPayload {
  return redactValueWithReport(payload).value as AgentEventPayload;
}

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

function isDurableEvent(type: AgentEventPayload['type']): boolean {
  return type === 'checkpoint.saved'
    || type === 'run.completed'
    || type === 'run.paused'
    || type === 'run.cancelled'
    || type === 'run.failed';
}
