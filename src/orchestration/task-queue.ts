import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { redactValueWithReport } from '../providers/redaction.js';
import { withFileLock, type FileLockOptions } from '../runtime/file-lock.js';

export type BackgroundTaskState =
  | 'pending'
  | 'running'
  | 'waiting_approval'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type BackgroundTaskIsolation = 'sandbox' | 'worktree';
const TASK_STATES = new Set<BackgroundTaskState>([
  'pending', 'running', 'waiting_approval', 'completed', 'failed', 'cancelled',
]);
const ISOLATIONS = new Set<BackgroundTaskIsolation>(['sandbox', 'worktree']);

export interface BackgroundTaskPayload {
  profile: string;
  objective: string;
  metadata?: Record<string, string | number | boolean | null>;
}

export interface BackgroundTaskResult {
  summary: string;
  evidenceIds: string[];
  data?: unknown;
}

export interface BackgroundTaskRecord {
  schemaVersion: 1;
  id: string;
  state: BackgroundTaskState;
  isolation: BackgroundTaskIsolation;
  payload: BackgroundTaskPayload;
  createdAt: string;
  updatedAt: string;
  attempts: number;
  maxAttempts: number;
  workerId?: string;
  leaseExpiresAt?: string;
  cancellationRequested?: boolean;
  waitingReason?: string;
  errorCode?: string;
  result?: BackgroundTaskResult;
}

interface QueueFile {
  version: 1;
  tasks: BackgroundTaskRecord[];
}

export interface EnqueueTaskInput {
  isolation: BackgroundTaskIsolation;
  payload: BackgroundTaskPayload;
  maxAttempts?: number;
}

export class PersistentTaskQueue {
  // 实例内队列与文件锁共同保证单写者：前者处理同对象并发，后者覆盖多实例和多进程。
  private writeQueue: Promise<unknown> = Promise.resolve();
  private readonly lockOptions: FileLockOptions;

  constructor(
    readonly filePath: string,
    private readonly now: () => Date = () => new Date(),
    lockOptions: FileLockOptions = {},
  ) {
    this.lockOptions = { timeoutMs: 10_000, ...lockOptions };
  }

  // 崩溃恢复：认领会写入 leaseExpiresAt，进程崩溃后任务停留在 running 且租约过期。
  // 这里把过期任务重新置为 pending（除非已请求取消），等待下一个 Worker 认领。
  async recoverExpired(): Promise<number> {
    return this.serial(async () => {
      const file = await this.readUnlocked();
      const current = this.now().getTime();
      let recovered = 0;
      for (const task of file.tasks) {
        if (task.state !== 'running') continue;
        if (task.leaseExpiresAt && Date.parse(task.leaseExpiresAt) > current) continue;
        task.state = task.cancellationRequested ? 'cancelled' : 'pending';
        task.workerId = undefined;
        task.leaseExpiresAt = undefined;
        task.updatedAt = this.now().toISOString();
        recovered += 1;
      }
      if (recovered) await this.write(file);
      return recovered;
    });
  }

  async enqueue(input: EnqueueTaskInput): Promise<BackgroundTaskRecord> {
    return this.serial(async () => {
      const file = await this.readUnlocked();
      const timestamp = this.now().toISOString();
      const task: BackgroundTaskRecord = {
        schemaVersion: 1,
        id: randomUUID(),
        state: 'pending',
        isolation: input.isolation,
        payload: validatePayload(input.payload),
        createdAt: timestamp,
        updatedAt: timestamp,
        attempts: 0,
        maxAttempts: boundedInteger(input.maxAttempts ?? 2, 1, 10, 'maxAttempts'),
      };
      file.tasks.push(task);
      await this.write(file);
      return structuredClone(task);
    });
  }

  // 认领即写入租约：Worker 需在租约期内持续 heartbeat，否则任务会被 recoverExpired 移交其他 Worker；
  // attempts 在认领时递增，用于重试计数与 release 时回退。
  async claim(workerId: string, leaseMs = 60_000): Promise<BackgroundTaskRecord | undefined> {
    if (!workerId.trim()) throw new Error('workerId 不能为空');
    boundedInteger(leaseMs, 1_000, 30 * 60_000, 'leaseMs');
    return this.serial(async () => {
      const file = await this.readUnlocked();
      const task = file.tasks.find((item) => item.state === 'pending' && !item.cancellationRequested);
      if (!task) return undefined;
      const now = this.now();
      task.state = 'running';
      task.workerId = workerId;
      task.leaseExpiresAt = new Date(now.getTime() + leaseMs).toISOString();
      task.updatedAt = now.toISOString();
      task.attempts += 1;
      await this.write(file);
      return structuredClone(task);
    });
  }

  async heartbeat(taskId: string, workerId: string, leaseMs = 60_000): Promise<void> {
    await this.transition(taskId, (task) => {
      requireWorker(task, workerId);
      task.leaseExpiresAt = new Date(this.now().getTime() + leaseMs).toISOString();
    });
  }

  async complete(taskId: string, workerId: string, result: BackgroundTaskResult): Promise<BackgroundTaskRecord> {
    return this.transition(taskId, (task) => {
      requireWorker(task, workerId);
      task.state = task.cancellationRequested ? 'cancelled' : 'completed';
      task.result = task.cancellationRequested ? undefined : sanitizeResult(result);
      clearLease(task);
    });
  }

  async waitForApproval(taskId: string, workerId: string, reason: string, result?: BackgroundTaskResult): Promise<BackgroundTaskRecord> {
    return this.transition(taskId, (task) => {
      requireWorker(task, workerId);
      task.state = 'waiting_approval';
      task.waitingReason = reason.slice(0, 500);
      task.result = result ? sanitizeResult(result) : undefined;
      clearLease(task);
    });
  }

  async fail(taskId: string, workerId: string, code: string, retryable: boolean): Promise<BackgroundTaskRecord> {
    return this.transition(taskId, (task) => {
      requireWorker(task, workerId);
      task.errorCode = code.slice(0, 128);
      task.state = retryable && task.attempts < task.maxAttempts ? 'pending' : 'failed';
      clearLease(task);
    });
  }

  async release(taskId: string, workerId: string): Promise<BackgroundTaskRecord> {
    return this.transition(taskId, (task) => {
      requireWorker(task, workerId);
      task.state = task.cancellationRequested ? 'cancelled' : 'pending';
      task.attempts = Math.max(0, task.attempts - 1);
      clearLease(task);
    });
  }

  async cancel(taskId: string): Promise<BackgroundTaskRecord> {
    return this.transition(taskId, (task) => {
      if (task.state === 'completed' || task.state === 'failed' || task.state === 'cancelled') return;
      task.cancellationRequested = true;
      task.state = 'cancelled';
      clearLease(task);
    });
  }

  async resume(taskId: string): Promise<BackgroundTaskRecord> {
    return this.transition(taskId, (task) => {
      if (task.state !== 'waiting_approval' && task.state !== 'failed' && task.state !== 'cancelled') {
        throw new Error(`任务 ${task.id} 当前状态不能恢复：${task.state}`);
      }
      task.state = 'pending';
      task.cancellationRequested = false;
      task.waitingReason = undefined;
      task.errorCode = undefined;
      task.result = undefined;
      clearLease(task);
    });
  }

  async get(taskId: string): Promise<BackgroundTaskRecord | undefined> {
    return this.serial(async () => {
      const task = (await this.readUnlocked()).tasks.find((item) => item.id === taskId);
      return task ? structuredClone(task) : undefined;
    });
  }

  async list(): Promise<BackgroundTaskRecord[]> {
    return this.serial(async () => (await this.readUnlocked()).tasks
      .map((task) => structuredClone(task))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt)));
  }

  private async transition(
    taskId: string,
    change: (task: BackgroundTaskRecord) => void,
  ): Promise<BackgroundTaskRecord> {
    return this.serial(async () => {
      const file = await this.readUnlocked();
      const task = file.tasks.find((item) => item.id === taskId);
      if (!task) throw new Error(`后台任务不存在：${taskId}`);
      change(task);
      task.updatedAt = this.now().toISOString();
      await this.write(file);
      return structuredClone(task);
    });
  }

  // 所有读写先进入实例队列，再取得跨进程文件锁；失败只终止当前操作，不堵塞后续调用。
  private async serial<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.writeQueue.then(async () => {
      await mkdir(dirname(this.filePath), { recursive: true });
      return withFileLock(`${this.filePath}.lock`, operation, this.lockOptions);
    });
    this.writeQueue = next.catch(() => undefined);
    return next;
  }

  // 队列文件来自磁盘，是不可信输入，读入后必须经 isQueueFile 校验再使用。
  // 缺失(ENOENT)视为空队列；结构损坏则抛错失败关闭，绝不静默重置，避免丢失任务记录。
  private async readUnlocked(): Promise<QueueFile> {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, 'utf8')) as unknown;
      if (!isQueueFile(parsed)) throw new Error('后台任务队列结构无效');
      return parsed;
    } catch (error) {
      if (error instanceof Error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { version: 1, tasks: [] };
      }
      throw error;
    }
  }

  // 落盘用同目录临时文件 + rename：进程写一半崩溃也不会留下半截队列文件。
  // 写入前先脱敏并以 0o600 权限保存，避免队列携带的 evidence 泄漏给其他进程。
  private async write(file: QueueFile): Promise<void> {
    const temporary = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    const sanitized = redactValueWithReport(file).value;
    try {
      await writeFile(temporary, `${JSON.stringify(sanitized)}\n`, { encoding: 'utf8', mode: 0o600 });
      await rename(temporary, this.filePath);
    } finally {
      await rm(temporary, { force: true });
    }
  }
}

function requireWorker(task: BackgroundTaskRecord, workerId: string): void {
  if (task.state !== 'running' || task.workerId !== workerId) {
    throw new Error(`任务 ${task.id} 不属于 Worker ${workerId}`);
  }
}

function clearLease(task: BackgroundTaskRecord): void {
  task.workerId = undefined;
  task.leaseExpiresAt = undefined;
}

function validatePayload(payload: BackgroundTaskPayload): BackgroundTaskPayload {
  if (!payload.profile.trim() || payload.profile.length > 64) throw new Error('后台任务 profile 无效');
  if (!payload.objective.trim() || payload.objective.length > 50_000) throw new Error('后台任务 objective 无效');
  if (payload.metadata !== undefined) {
    if (!payload.metadata || typeof payload.metadata !== 'object' || Array.isArray(payload.metadata)) {
      throw new Error('后台任务 metadata 无效');
    }
    const entries = Object.entries(payload.metadata);
    if (entries.length > 256 || entries.some(([key, item]) => key.length < 1 || key.length > 128
      || (item !== null && !['string', 'number', 'boolean'].includes(typeof item))
      || (typeof item === 'number' && !Number.isFinite(item)))) throw new Error('后台任务 metadata 无效');
  }
  return {
    profile: payload.profile.trim(),
    objective: payload.objective,
    metadata: payload.metadata ? structuredClone(payload.metadata) : undefined,
  };
}

function sanitizeResult(result: BackgroundTaskResult): BackgroundTaskResult {
  if (typeof result.summary !== 'string' || !Array.isArray(result.evidenceIds)) {
    throw new Error('后台任务结果无效');
  }
  return {
    summary: result.summary.slice(0, 20_000),
    evidenceIds: [...new Set(result.evidenceIds.filter((item): item is string => typeof item === 'string'))]
      .slice(0, 1_000)
      .map((item) => item.slice(0, 1_000)),
    data: result.data,
  };
}

function boundedInteger(value: number, min: number, max: number, name: string): number {
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${name} 无效`);
  return value;
}

// 校验函数把磁盘 JSON 当作不可信输入逐字段核对，防止被篡改或损坏的任务记录进入运行路径。
function isQueueFile(value: unknown): value is QueueFile {
  if (!value || typeof value !== 'object') return false;
  const file = value as Partial<QueueFile>;
  return file.version === 1 && Array.isArray(file.tasks) && file.tasks.every(isTaskRecord);
}

function isTaskRecord(value: unknown): value is BackgroundTaskRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const task = value as Partial<BackgroundTaskRecord>;
  if (task.schemaVersion !== 1 || typeof task.id !== 'string' || task.id.length < 1 || task.id.length > 128
    || typeof task.state !== 'string' || !TASK_STATES.has(task.state as BackgroundTaskState)
    || typeof task.isolation !== 'string' || !ISOLATIONS.has(task.isolation as BackgroundTaskIsolation)
    || !validDate(task.createdAt) || !validDate(task.updatedAt)
    || !Number.isInteger(task.attempts) || (task.attempts ?? -1) < 0
    || !Number.isInteger(task.maxAttempts) || (task.maxAttempts ?? 0) < 1 || (task.maxAttempts ?? 0) > 10
    || !isTaskPayload(task.payload)) return false;
  if (task.workerId !== undefined && (typeof task.workerId !== 'string' || task.workerId.length > 256)) return false;
  if (task.leaseExpiresAt !== undefined && !validDate(task.leaseExpiresAt)) return false;
  if (task.cancellationRequested !== undefined && typeof task.cancellationRequested !== 'boolean') return false;
  if (task.waitingReason !== undefined && (typeof task.waitingReason !== 'string' || task.waitingReason.length > 500)) return false;
  if (task.errorCode !== undefined && (typeof task.errorCode !== 'string' || task.errorCode.length > 128)) return false;
  return task.result === undefined || isTaskResult(task.result);
}

function isTaskPayload(value: unknown): value is BackgroundTaskPayload {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const payload = value as Partial<BackgroundTaskPayload>;
  if (typeof payload.profile !== 'string' || payload.profile.length < 1 || payload.profile.length > 64
    || typeof payload.objective !== 'string' || payload.objective.trim().length < 1 || payload.objective.length > 50_000) return false;
  if (payload.metadata === undefined) return true;
  if (!payload.metadata || typeof payload.metadata !== 'object' || Array.isArray(payload.metadata)) return false;
  return Object.entries(payload.metadata).length <= 256
    && Object.entries(payload.metadata).every(([key, item]) => key.length > 0 && key.length <= 128
      && (item === null || ['string', 'number', 'boolean'].includes(typeof item)));
}

function isTaskResult(value: unknown): value is BackgroundTaskResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const result = value as Partial<BackgroundTaskResult>;
  return typeof result.summary === 'string' && result.summary.length <= 20_000
    && Array.isArray(result.evidenceIds) && result.evidenceIds.length <= 1_000
    && result.evidenceIds.every((item) => typeof item === 'string' && item.length <= 1_000);
}

function validDate(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}
