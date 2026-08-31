import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

export type ApprovalScope = 'once' | 'session' | 'project' | 'persistent';
export type ApprovalDecisionKind = 'allow' | 'deny';

export interface ApprovalRequest {
  id: string;
  sessionId?: string;
  runId?: string;
  callId?: string;
  toolName: string;
  permission: string;
  arguments: Record<string, unknown>;
  argumentsHash: string;
  workspaceRoot: string;
  workspaceRevision?: string;
  reasonCode: string;
  reason: string;
  createdAt: string;
  expiresAt?: string;
}

export interface ApprovalDecision {
  decision: ApprovalDecisionKind;
  scope: ApprovalScope;
  decidedAt: string;
  ruleId?: string;
  reason?: string;
}

export interface ApprovalStore {
  find(request: ApprovalRequest): Promise<ApprovalDecision | undefined>;
  save(request: ApprovalRequest, decision: ApprovalDecision): Promise<void>;
  remove?(request: ApprovalRequest): Promise<void>;
}

export class MemoryApprovalStore implements ApprovalStore {
  private readonly records: Array<{ request: ApprovalRequest; decision: ApprovalDecision }> = [];

  async find(request: ApprovalRequest): Promise<ApprovalDecision | undefined> {
    const index = this.records.findIndex((record) => matches(record.request, request, record.decision.scope));
    if (index < 0) return undefined;
    const record = this.records[index]!;
    // once 决策是单次授权：命中后立即消费（移除记录），防止同一动作被重复批准。
    if (record.decision.scope === 'once') this.records.splice(index, 1);
    return structuredClone(record.decision);
  }

  async save(request: ApprovalRequest, decision: ApprovalDecision): Promise<void> {
    this.records.push({ request: structuredClone(request), decision: structuredClone(decision) });
  }

  async remove(request: ApprovalRequest): Promise<void> {
    for (let index = this.records.length - 1; index >= 0; index -= 1) {
      if (this.records[index] && matches(this.records[index]!.request, request, this.records[index]!.decision.scope)) {
        this.records.splice(index, 1);
      }
    }
  }
}

interface StoredApprovalRecord {
  request: ApprovalRequest;
  decision: ApprovalDecision;
}

export class JsonApprovalStore implements ApprovalStore {
  private writeQueue: Promise<unknown> = Promise.resolve();

  constructor(readonly filePath = resolve(process.cwd(), '.echolens', 'approvals.json')) {}

  async find(request: ApprovalRequest): Promise<ApprovalDecision | undefined> {
    return this.serial(async () => {
      const records = await this.read();
      const index = records.findIndex((record) => matches(record.request, request, record.decision.scope));
      if (index < 0) return undefined;
      const record = records[index]!;
      if (record.decision.scope === 'once') {
        records.splice(index, 1);
        await this.write(records);
      }
      return structuredClone(record.decision);
    });
  }

  async save(request: ApprovalRequest, decision: ApprovalDecision): Promise<void> {
    await this.serial(async () => {
      const records = await this.read();
      records.push({ request: persistedRequest(request), decision: structuredClone(decision) });
      await this.write(records);
    });
  }

  async remove(request: ApprovalRequest): Promise<void> {
    await this.serial(async () => {
      const records = (await this.read()).filter((record) => !matches(record.request, request, record.decision.scope));
      await this.write(records);
    });
  }

  // 所有读取-修改-写回都串行经过 writeQueue：并行工具调用并发改动 approvals.json 时，
  // 后续操作会排队在前一个完成后执行，避免丢更新或写坏文件。
  private async serial<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.writeQueue.then(operation);
    this.writeQueue = next.catch(() => undefined);
    return next;
  }

  private async read(): Promise<StoredApprovalRecord[]> {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, 'utf8')) as unknown;
      return Array.isArray(parsed) ? parsed.filter(isStoredRecord) : [];
    } catch { return []; }
  }

  private async write(records: StoredApprovalRecord[]): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    // 先写临时文件再原子 rename：审批记录不会因写入中途崩溃而损坏；
    // mode 0o600 在 POSIX 平台限制其他账户读取审批文件。
    const temporary = `${this.filePath}.${process.pid}.tmp`;
    const sanitized = records.map((record) => ({
      request: persistedRequest(record.request),
      decision: record.decision,
    }));
    await writeFile(temporary, `${JSON.stringify(sanitized)}\n`, { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, this.filePath);
  }
}

// 落盘时丢弃参数内容只保留 argumentsHash：approvals.json 不保存用户改动数据，
// 且匹配仍按参数哈希进行，与参数是否敏感无关。
function persistedRequest(request: ApprovalRequest): ApprovalRequest {
  return { ...structuredClone(request), arguments: {} };
}

export interface PolicyRule {
  id: string;
  effect: 'allow' | 'deny' | 'require_approval';
  toolName?: string;
  permission?: string;
  pathPrefix?: string;
  command?: string;
  domain?: string;
  explanation: string;
}

export interface PolicyAction {
  toolName: string;
  permission: string;
  path?: string;
  command?: string;
  domain?: string;
}

export interface PolicyDecision {
  decision: 'allow' | 'deny' | 'require_approval';
  matchedRuleIds: string[];
  explanation: string;
}

export class PolicyEngine {
  constructor(private readonly rules: readonly PolicyRule[] = []) {}

  evaluate(action: PolicyAction): PolicyDecision {
    // deny 优先：同一动作同时命中多条规则时，deny > require_approval > allow；
    // 未命中任何规则时，只读动作放行，带副作用动作默认要求审批。
    const matched = this.rules.filter((rule) => matchesRule(rule, action));
    const denied = matched.find((rule) => rule.effect === 'deny');
    if (denied) return { decision: 'deny', matchedRuleIds: matched.map((rule) => rule.id), explanation: denied.explanation };
    const approval = matched.find((rule) => rule.effect === 'require_approval');
    if (approval) return { decision: 'require_approval', matchedRuleIds: matched.map((rule) => rule.id), explanation: approval.explanation };
    const allowed = matched.find((rule) => rule.effect === 'allow');
    if (allowed) return { decision: 'allow', matchedRuleIds: matched.map((rule) => rule.id), explanation: allowed.explanation };
    return {
      decision: action.permission === 'workspace.read' ? 'allow' : 'require_approval',
      matchedRuleIds: [],
      explanation: action.permission === 'workspace.read' ? '只读动作默认允许' : '副作用动作默认需要审批',
    };
  }
}

export function createApprovalRequest(input: Omit<ApprovalRequest, 'argumentsHash'>): ApprovalRequest {
  return { ...structuredClone(input), argumentsHash: hashArguments(input.arguments) };
}

export function hashArguments(value: Record<string, unknown>): string {
  return `sha256:${createHash('sha256').update(stableJson(value)).digest('hex')}`;
}

function matches(stored: ApprovalRequest, current: ApprovalRequest, scope: ApprovalScope): boolean {
  // 匹配以工具名/权限/参数哈希为基准；scope 限定复用边界（session 限同一会话、project 限同一工作区），
  // 过期决策不命中。workspaceRevision 仅双方都携带时才要求相等，单侧缺失不据此否决。
  if (stored.toolName !== current.toolName || stored.permission !== current.permission
    || stored.argumentsHash !== current.argumentsHash) return false;
  if (stored.workspaceRevision && current.workspaceRevision && stored.workspaceRevision !== current.workspaceRevision) return false;
  if (scope === 'session' && stored.sessionId !== current.sessionId) return false;
  if (scope === 'project' && stored.workspaceRoot !== current.workspaceRoot) return false;
  if (stored.expiresAt && Date.parse(stored.expiresAt) <= Date.now()) return false;
  return true;
}

function matchesRule(rule: PolicyRule, action: PolicyAction): boolean {
  if (rule.toolName && rule.toolName !== action.toolName) return false;
  if (rule.permission && rule.permission !== action.permission) return false;
  if (rule.pathPrefix && (!action.path || !action.path.replaceAll('\\', '/').startsWith(rule.pathPrefix.replaceAll('\\', '/')))) return false;
  if (rule.command && rule.command !== action.command) return false;
  if (rule.domain && rule.domain !== action.domain) return false;
  return true;
}

// 稳定序列化用于参数哈希：对象键排序后再编码，参数键的书写顺序不影响匹配结果。
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function isStoredRecord(value: unknown): value is StoredApprovalRecord {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<StoredApprovalRecord>;
  return Boolean(candidate.request && candidate.decision
    && typeof candidate.request.toolName === 'string'
    && typeof candidate.request.argumentsHash === 'string'
    && (candidate.decision.scope === 'once' || candidate.decision.scope === 'session'
      || candidate.decision.scope === 'project' || candidate.decision.scope === 'persistent'));
}
