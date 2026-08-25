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

const defaults: RetryPolicyOptions = {
  maxRetries: 2,
  baseDelayMs: 500,
  maxDelayMs: 30_000,
  totalBudgetMs: 45_000,
  random: Math.random,
  now: Date.now,
  sleep: abortableSleep,
};

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

export function parseRetryAfter(value: string | null, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) return undefined;
  return Math.max(0, timestamp - now);
}

function retryDelay(error: ProviderError, attempt: number, policy: RetryPolicyOptions): number {
  if (error.retryAfterMs !== undefined) return Math.min(error.retryAfterMs, policy.maxDelayMs);
  const exponential = policy.baseDelayMs * 2 ** (attempt - 1);
  const jitter = 0.5 + Math.min(1, Math.max(0, policy.random()));
  return Math.min(policy.maxDelayMs, Math.round(exponential * jitter));
}

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
