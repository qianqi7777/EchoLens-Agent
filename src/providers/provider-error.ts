import { redactText, redactValue } from './redaction.js';

export type ProviderErrorKind =
  | 'authentication'
  | 'permission'
  | 'billing'
  | 'rate_limit'
  | 'network'
  | 'timeout'
  | 'upstream'
  | 'context_length'
  | 'content_filter'
  | 'invalid_request'
  | 'not_found'
  | 'protocol'
  | 'cancelled'
  | 'unknown';

export interface ProviderErrorDetails {
  code?: string;
  type?: string;
  message?: string;
}

export interface ProviderErrorOptions {
  kind: ProviderErrorKind;
  message: string;
  retryable: boolean;
  status?: number;
  code?: string;
  requestId?: string;
  retryAfterMs?: number;
  attempts?: number;
  elapsedMs?: number;
  details?: ProviderErrorDetails;
  cause?: unknown;
}

export class ProviderError extends Error {
  readonly kind: ProviderErrorKind;
  readonly retryable: boolean;
  readonly status?: number;
  readonly code?: string;
  readonly requestId?: string;
  readonly retryAfterMs?: number;
  readonly attempts?: number;
  readonly elapsedMs?: number;
  readonly details?: ProviderErrorDetails;

  constructor(options: ProviderErrorOptions) {
    super(redactText(options.message), {
      cause: options.cause === undefined ? undefined : redactValue(options.cause),
    });
    this.name = 'ProviderError';
    this.kind = options.kind;
    this.retryable = options.retryable;
    this.status = options.status;
    this.code = options.code ? redactText(options.code) : undefined;
    this.requestId = options.requestId ? redactText(options.requestId) : undefined;
    this.retryAfterMs = options.retryAfterMs;
    this.attempts = options.attempts;
    this.elapsedMs = options.elapsedMs;
    this.details = options.details
      ? {
          code: options.details.code ? redactText(options.details.code) : undefined,
          type: options.details.type ? redactText(options.details.type) : undefined,
          message: options.details.message ? redactText(options.details.message) : undefined,
        }
      : undefined;
  }

  withAttemptMetadata(attempts: number, elapsedMs: number): ProviderError {
    return new ProviderError({
      kind: this.kind,
      message: this.message,
      retryable: this.retryable,
      status: this.status,
      code: this.code,
      requestId: this.requestId,
      retryAfterMs: this.retryAfterMs,
      attempts,
      elapsedMs,
      details: this.details,
      cause: this.cause,
    });
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      kind: this.kind,
      message: this.message,
      retryable: this.retryable,
      status: this.status,
      code: this.code,
      requestId: this.requestId,
      retryAfterMs: this.retryAfterMs,
      attempts: this.attempts,
      elapsedMs: this.elapsedMs,
      details: this.details,
    };
  }
}

export function cancelledProviderError(cause?: unknown): ProviderError {
  return new ProviderError({
    kind: 'cancelled',
    message: '模型请求已取消',
    retryable: false,
    code: 'request_cancelled',
    cause,
  });
}
