import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import type { AgentEvent } from './events.js';

export const AUDIT_EXPORT_VERSION = 1 as const;

export interface AuditFailure {
  line: number;
  seq?: number;
  eventId?: string;
  reason: string;
}

export interface AuditVerificationResult {
  valid: boolean;
  chainPresent: boolean;
  eventCount: number;
  filePath?: string;
  failure?: AuditFailure;
}

export interface AuditExport {
  version: typeof AUDIT_EXPORT_VERSION;
  exportedAt: string;
  sourceFile: string;
  sessionId?: string;
  events: AgentEvent[];
}

/** 校验 JSONL 审计日志；失败返回定位信息，不把断链静默降级成“无效”。 */
export async function verifyAuditLog(filePath: string): Promise<AuditVerificationResult> {
  let text: string;
  try {
    text = await readFile(filePath, 'utf8');
  } catch (error) {
    return { valid: false, chainPresent: false, eventCount: 0, filePath, failure: { line: 0, reason: `无法读取审计日志：${String(error)}` } };
  }
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  const events: AgentEvent[] = [];
  for (const [index, line] of lines.entries()) {
    if (!line) return invalid(filePath, events, { line: index + 1, reason: '存在空行' });
    let value: unknown;
    try { value = JSON.parse(line); }
    catch { return invalid(filePath, events, { line: index + 1, reason: '不是合法 JSON' }); }
    if (!isAgentEvent(value)) return invalid(filePath, events, { line: index + 1, reason: '事件结构无效' });
    events.push(value);
  }
  return verifyAuditEvents(events, filePath);
}

/** 校验已加载的事件序列，供导出与离线工具复用。 */
export function verifyAuditEvents(events: readonly AgentEvent[], filePath?: string): AuditVerificationResult {
  const chainPresent = events.some((event) => event.prevHash !== undefined);
  for (const [index, event] of events.entries()) {
    if (event.seq !== index + 1) return invalid(filePath, events, { line: index + 1, seq: event.seq, eventId: event.eventId, reason: `seq 不连续，期望 ${index + 1}` }, chainPresent);
    if (chainPresent) {
      const expectedPrev = index === 0 ? undefined : hashEvent(events[index - 1]!);
      if (event.prevHash !== expectedPrev) {
        return invalid(filePath, events, { line: index + 1, seq: event.seq, eventId: event.eventId, reason: index === 0 ? '首事件不应包含 prevHash' : '哈希链断裂' }, chainPresent);
      }
      if (index > 0 && event.prevHash === undefined) {
        return invalid(filePath, events, { line: index + 1, seq: event.seq, eventId: event.eventId, reason: '事件缺少 prevHash' }, chainPresent);
      }
    }
  }
  return { valid: true, chainPresent, eventCount: events.length, ...(filePath ? { filePath } : {}) };
}

/** 将已校验的 JSONL 记录导出为带版本字段的离线审计包。 */
export async function exportAuditLog(sourceFile: string, destination: string): Promise<AuditExport> {
  const verification = await verifyAuditLog(sourceFile);
  if (!verification.valid) {
    const failure = verification.failure;
    throw new Error(`审计日志校验失败（第 ${failure?.line ?? '?'} 行${failure?.seq ? `，seq=${failure.seq}` : ''}）：${failure?.reason ?? '未知错误'}`);
  }
  const text = await readFile(sourceFile, 'utf8');
  const events = text.split('\n').filter(Boolean).map((line) => JSON.parse(line) as AgentEvent);
  const bundle: AuditExport = {
    version: AUDIT_EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    sourceFile: path.basename(sourceFile),
    sessionId: events[0]?.sessionId,
    events,
  };
  await writeFile(destination, `${JSON.stringify(bundle, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  return bundle;
}

export function verifyAuditExport(value: unknown): AuditVerificationResult {
  if (!isRecord(value) || value.version !== AUDIT_EXPORT_VERSION || !Array.isArray(value.events)) {
    return { valid: false, chainPresent: false, eventCount: 0, failure: { line: 0, reason: '审计导出包版本或结构无效' } };
  }
  return verifyAuditEvents(value.events as AgentEvent[]);
}

export function hashAuditEvent(event: AgentEvent): string {
  return hashEvent(event);
}

function verifyAuditEventsWithCount(events: readonly AgentEvent[], filePath: string | undefined, failure: AuditFailure, chainPresent: boolean): AuditVerificationResult {
  return { valid: false, chainPresent, eventCount: events.length, ...(filePath ? { filePath } : {}), failure };
}

function invalid(filePath: string | undefined, events: readonly AgentEvent[], failure: AuditFailure, chainPresent = events.some((event) => event.prevHash !== undefined)): AuditVerificationResult {
  return verifyAuditEventsWithCount(events, filePath, failure, chainPresent);
}

function hashEvent(event: AgentEvent): string {
  const copy = { ...event };
  delete copy.prevHash;
  return createHash('sha256').update(JSON.stringify(copy), 'utf8').digest('hex');
}

function isAgentEvent(value: unknown): value is AgentEvent {
  if (!isRecord(value)) return false;
  return value.version === 1 && typeof value.eventId === 'string' && typeof value.sessionId === 'string'
    && Number.isInteger(value.seq) && (value.seq as number) > 0 && typeof value.timestamp === 'string'
    && isRecord(value.payload) && typeof value.payload.type === 'string';
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
