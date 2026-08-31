import { cancelledProviderError, ProviderError } from './provider-error.js';

export interface RetryPolicyOptions {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  totalBudgetMs: number;
  random: () => number;
  now: () => number;
  sleep: (delayMs: number, signal?: AbortSignal) => Promise<void>;
}

export type RetryPolicyOverrides = Partial<RetryPolicyOptions>;

export interface RetryExecution<T> {
  value: T;
  attempts: number;
  elapsedMs: number;
}

export interface RetryNotification {
  failedAttempt: number;
  nextAttempt: number;
  delayMs: number;
  code: string;
}

// 默认退避上限：maxRetries 限制重试次数，maxDelayMs 封顶单次 sleep，
// totalBudgetMs 是包含全部重试与等待在内的硬性时间预算，超出即失败。
const defaults: RetryPolicyOptions = {
  maxRetries: 2,
  baseDelayMs: 500,
  maxDelayMs: 30_000,
  totalBudgetMs: 45_000,
  random: Math.random,
  now: Date.now,
  sleep: abortableSleep,
};

/**
 * 带总预算约束的重试执行器。
 *
 * 每次调用前都会检查剩余时间预算并传给 operation，让单次尝试（如网络请求超时）
 * 不会超过剩余预算；只有显式 retryable 的错误才会触发退避重试。
 * @returns 成功值、尝试次数与总耗时。
 * @throws 超过总预算或错误不可重试时抛出 `ProviderError`（带 attempts/elapsedMs 元数据）。
 */
export async function runWithRetry<T>(
  operation: (attempt: number, remainingBudgetMs: number) => Promise<T>,
  overrides: RetryPolicyOverrides = {},
  signal?: AbortSignal,
  onRetry?: (notification: RetryNotification) => void | Promise<void>,
): Promise<RetryExecution<T>> {
  const policy = { ...defaults, ...overrides };
  const startedAt = policy.now();
  let attempts = 0;

  while (true) {
    throwIfAborted(signal);
    const remainingBudgetMs = policy.totalBudgetMs - Math.max(0, policy.now() - startedAt);
    if (remainingBudgetMs <= 0) {
      throw new ProviderError({
        kind: 'timeout',
        message: '模型请求超过总时间预算',
        retryable: false,
        code: 'request_budget_exhausted',
        attempts,
        elapsedMs: Math.max(0, policy.now() - startedAt),
      });
    }
    attempts += 1;
    try {
      const value = await operation(attempts, remainingBudgetMs);
      return {
        value,
        attempts,
        elapsedMs: Math.max(0, policy.now() - startedAt),
      };
    } catch (error) {
      const providerError = normalizeRetryError(error, signal);
      const elapsedMs = Math.max(0, policy.now() - startedAt);
      if (!providerError.retryable || attempts > policy.maxRetries) {
        throw providerError.withAttemptMetadata(attempts, elapsedMs);
      }

      const delayMs = retryDelay(providerError, attempts, policy);
      // 本次退避会直接撞上总预算时不再空等立即失败，避免在截止边缘的无效等待。
      if (elapsedMs + delayMs >= policy.totalBudgetMs) {
        throw providerError.withAttemptMetadata(attempts, elapsedMs);
      }

      await onRetry?.({
        failedAttempt: attempts,
        nextAttempt: attempts + 1,
        delayMs,
        code: providerError.code ?? providerError.kind,
      });

      try {
        await policy.sleep(delayMs, signal);
      } catch (sleepError) {
        if (signal?.aborted || isAbortError(sleepError)) {
          throw cancelledProviderError(sleepError).withAttemptMetadata(attempts, Math.max(0, policy.now() - startedAt));
        }
        throw sleepError;
      }
    }
  }
}

// Retry-After（RFC 9110）允许返回秒数或 HTTP 日期两种格式，统一换算为毫秒供退避使用。
export function parseRetryAfter(value: string | null, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) return undefined;
  return Math.max(0, timestamp - now);
}

// 优先遵循服务的 Retry-After 且受 maxDelayMs 封顶（防止远端返回超长 sleep）；
// 否则指数退避（base × 2^(attempt-1)）叠加随机抖动，打散多请求重试的同步冲击。
function retryDelay(error: ProviderError, attempt: number, policy: RetryPolicyOptions): number {
  if (error.retryAfterMs !== undefined) return Math.min(error.retryAfterMs, policy.maxDelayMs);
  const exponential = policy.baseDelayMs * 2 ** (attempt - 1);
  const jitter = 0.5 + Math.min(1, Math.max(0, policy.random()));
  return Math.min(policy.maxDelayMs, Math.round(exponential * jitter));
}

// 退避等待必须响应取消：用户撤销时若继续 sleep 到自然结束，会让整个请求长时间无法返回。
// 外部 signal 已 aborted 时立即以取消错误结束等待，不进入计时。
async function abortableSleep(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (delayMs <= 0) return;
  await new Promise<void>((resolve, reject) => {
    const done = () => {
      signal?.removeEventListener('abort', abort);
      resolve();
    };
    const timer = setTimeout(done, delayMs);
    const abort = () => {
      clearTimeout(timer);
      reject(cancelledProviderError(signal?.reason));
    };
    if (signal?.aborted) {
      abort();
      return;
    }
    signal?.addEventListener('abort', abort, { once: true });
  });
}

// 只有显式标记 retryable 的 ProviderError 才会被重试；取消与未知错误默认不可重试，
// 避免在请求可能已成功或属于请求方错误时重复发送（重复计费或掩盖真实缺陷）。
function normalizeRetryError(error: unknown, signal?: AbortSignal): ProviderError {
  if (signal?.aborted) return cancelledProviderError(error);
  if (error instanceof ProviderError) return error;
  if (isAbortError(error)) return cancelledProviderError(error);
  return new ProviderError({
    kind: 'unknown',
    message: '模型请求发生未知错误',
    retryable: false,
    code: 'unknown_provider_error',
    cause: error,
  });
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw cancelledProviderError(signal.reason);
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}
