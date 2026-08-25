import type {
  ModelProvider,
  ProviderCapabilities,
  ProviderRequest,
  ProviderResult,
  ProviderStreamEvent,
} from '../types.js';
import { cancelledProviderError, ProviderError, type ProviderErrorKind } from '../provider-error.js';
import { safeProviderDetails } from '../redaction.js';
import { createRequestSignal } from '../request-signal.js';
import { parseRetryAfter, runWithRetry, type RetryPolicyOverrides } from '../retry-policy.js';
import { ChatCompletionsCodec } from './chat-codec.js';
import { ResponsesCodec } from './responses-codec.js';
import type { EncodedProviderRequest, OpenAICompatibleProviderOptions, ProtocolCodec } from './types.js';
import { parseSse } from './sse.js';
import { decodeProviderStream } from './streaming.js';

const baseCapabilities: ProviderCapabilities = {
  maxContextTokens: 128_000,
  supportsStreaming: false,
  supportsToolCalls: true,
  supportsParallelToolCalls: true,
  supportsStructuredOutput: false,
  supportsPromptCaching: false,
  supportsUsageReporting: true,
};

export class OpenAICompatibleProvider implements ModelProvider {
  readonly model: string;
  readonly capabilities: ProviderCapabilities;
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly codec: ProtocolCodec;
  private readonly fetchImplementation: typeof globalThis.fetch;
  private readonly requestTimeoutMs: number;
  private readonly retry: RetryPolicyOverrides;

  constructor(options: OpenAICompatibleProviderOptions) {
    this.model = options.model;
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.apiKey = options.apiKey;
    this.codec = codecFor(options.protocol);
    this.fetchImplementation = options.fetch ?? globalThis.fetch;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
    this.retry = options.retry ?? {};
    this.capabilities = { ...baseCapabilities, ...options.capabilities };
  }

  async complete(request: ProviderRequest): Promise<ProviderResult> {
    this.validateRequest(request);
    const encoded = this.codec.encode(this.model, request);
    const execution = await runWithRetry(
      (_attempt, remainingBudgetMs) => this.completeOnce(
        encoded,
        request.signal,
        Math.min(this.requestTimeoutMs, remainingBudgetMs),
      ),
      this.retry,
      request.signal,
    );
    return {
      ...execution.value,
      transport: {
        attempts: execution.attempts,
        retries: execution.attempts - 1,
        elapsedMs: execution.elapsedMs,
      },
    };
  }

  async *stream(request: ProviderRequest): AsyncGenerator<ProviderStreamEvent> {
    this.validateRequest(request);
    if (!this.capabilities.supportsStreaming) {
      throw new ProviderError({
        kind: 'invalid_request',
        message: '当前 Provider 未声明流式响应能力',
        retryable: false,
        code: 'streaming_unsupported',
      });
    }
    const encoded = this.codec.encode(this.model, request);
    const started = performance.now();
    const retryEvents: ProviderStreamEvent[] = [];
    const execution = await runWithRetry(
      (_attempt, remainingBudgetMs) => this.openStreamOnce(
        encoded,
        request.signal,
        Math.min(this.requestTimeoutMs, remainingBudgetMs),
      ),
      this.retry,
      request.signal,
      ({ nextAttempt, delayMs, code }) => {
        retryEvents.push({ type: 'transport.retry', attempt: nextAttempt, delayMs, code });
      },
    );
    for (const event of retryEvents) yield event;
    const { response, attempt } = execution.value;
    const requestId = response.headers.get('x-request-id') ?? undefined;
    yield { type: 'response.started', requestId };
    try {
      for await (const event of decodeProviderStream(
        this.codec.protocol,
        parseSse(response.body),
        requestId,
      )) {
        if (event.type === 'response.completed') {
          yield {
            ...event,
            result: {
              ...event.result,
              transport: {
                attempts: execution.attempts,
                retries: execution.attempts - 1,
                elapsedMs: Math.max(0, Math.round(performance.now() - started)),
              },
            },
          };
        } else {
          yield event;
        }
      }
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      if (request.signal?.aborted) throw cancelledProviderError(error);
      if (attempt.timedOut()) {
        throw new ProviderError({
          kind: 'timeout',
          message: '模型流在完成前超时',
          retryable: false,
          code: 'response_timeout',
          requestId,
          cause: error,
        });
      }
      throw new ProviderError({
        kind: 'protocol',
        message: '模型流在完成前中断、超时或格式无效',
        retryable: false,
        code: 'response_stream_interrupted',
        requestId,
        cause: error,
      });
    } finally {
      attempt.dispose();
    }
  }

  private async openStreamOnce(
    encoded: EncodedProviderRequest,
    externalSignal: AbortSignal | undefined,
    timeoutMs: number,
  ): Promise<{ response: Response; attempt: ReturnType<typeof createRequestSignal> }> {
    const attempt = createRequestSignal(externalSignal, timeoutMs, 'Model stream connection timed out');
    try {
      let response: Response;
      try {
        response = await this.fetchImplementation(`${this.baseUrl}${encoded.endpoint}`, {
          method: 'POST',
          headers: {
            accept: 'text/event-stream',
            'content-type': 'application/json',
            ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
          },
          body: JSON.stringify({ ...encoded.body, stream: true }),
          signal: attempt.signal,
        });
      } catch (error) {
        if (externalSignal?.aborted) throw cancelledProviderError(error);
        if (attempt.timedOut()) {
          throw new ProviderError({
            kind: 'timeout',
            message: '模型流式连接超时',
            retryable: true,
            code: 'upstream_timeout',
            cause: error,
          });
        }
        throw new ProviderError({
          kind: 'network',
          message: '无法连接模型流式服务',
          retryable: true,
          code: 'network_error',
          cause: error,
        });
      }
      const requestId = response.headers.get('x-request-id') ?? undefined;
      if (!response.ok) throw await providerHttpError(response, requestId);
      return { response, attempt };
    } catch (error) {
      attempt.dispose();
      throw error;
    }
  }

  private validateRequest(request: ProviderRequest): void {
    if (request.responseFormat && !this.capabilities.supportsStructuredOutput) {
      throw new ProviderError({
        kind: 'invalid_request',
        message: '当前 Provider 未声明 Structured Outputs 能力',
        retryable: false,
        code: 'structured_output_unsupported',
      });
    }
  }

  private async completeOnce(
    encoded: EncodedProviderRequest,
    externalSignal: AbortSignal | undefined,
    timeoutMs: number,
  ): Promise<ProviderResult> {
    const attempt = createRequestSignal(externalSignal, timeoutMs, 'Model request timed out');
    try {
      let response: Response;
      try {
        response = await this.fetchImplementation(`${this.baseUrl}${encoded.endpoint}`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
          },
          body: JSON.stringify(encoded.body),
          signal: attempt.signal,
        });
      } catch (error) {
        if (externalSignal?.aborted) throw cancelledProviderError(error);
        if (attempt.timedOut()) {
          throw new ProviderError({
            kind: 'timeout',
            message: '模型请求超时',
            retryable: true,
            code: 'upstream_timeout',
            cause: error,
          });
        }
        throw new ProviderError({
          kind: 'network',
          message: '无法连接模型服务',
          retryable: true,
          code: 'network_error',
          cause: error,
        });
      }

      const requestId = response.headers.get('x-request-id') ?? undefined;
      if (!response.ok) throw await providerHttpError(response, requestId);

      let payload: unknown;
      try {
        payload = await response.json();
      } catch (error) {
        if (externalSignal?.aborted) throw cancelledProviderError(error);
        if (attempt.timedOut()) {
          throw new ProviderError({
            kind: 'timeout',
            message: '模型响应在传输完成前超时',
            retryable: false,
            code: 'response_timeout',
            requestId,
            cause: error,
          });
        }
        throw new ProviderError({
          kind: 'protocol',
          message: '模型服务返回了无法解析的响应',
          retryable: false,
          code: 'invalid_provider_response',
          requestId,
          cause: error,
        });
      }

      try {
        return this.codec.decode(payload, requestId);
      } catch (error) {
        if (error instanceof ProviderError) throw error;
        throw new ProviderError({
          kind: 'protocol',
          message: '模型响应不符合所选协议',
          retryable: false,
          code: 'provider_protocol_mismatch',
          requestId,
          cause: error,
        });
      }
    } finally {
      attempt.dispose();
    }
  }
}

async function providerHttpError(response: Response, requestId?: string): Promise<ProviderError> {
  const details = await readSafeErrorDetails(response);
  const kind = errorKind(response.status, details.code, details.type, details.message);
  return new ProviderError({
    kind,
    message: errorMessage(kind, response.status),
    retryable: isRetryableStatus(response.status),
    status: response.status,
    code: details.code ?? `http_${response.status}`,
    requestId,
    retryAfterMs: parseRetryAfter(response.headers.get('retry-after')),
    details,
  });
}

async function readSafeErrorDetails(response: Response): Promise<ReturnType<typeof safeProviderDetails>> {
  try {
    return safeProviderDetails(await response.json());
  } catch {
    return {};
  }
}

function errorKind(status: number, ...details: Array<string | undefined>): ProviderErrorKind {
  const description = details.filter(Boolean).join(' ').toLowerCase();
  if (/context|token.?limit|max(?:imum)?.?token|request.?too.?large/.test(description) || status === 413) {
    return 'context_length';
  }
  if (/content.?filter|safety|moderation|blocked/.test(description)) return 'content_filter';
  if (status === 401) return 'authentication';
  if (status === 403) return 'permission';
  if (status === 402) return 'billing';
  if (status === 429) return 'rate_limit';
  if (status === 408) return 'timeout';
  if (status === 404) return 'not_found';
  if (status === 400 || status === 409 || status === 422) return 'invalid_request';
  if (status >= 500) return 'upstream';
  return 'unknown';
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 429 || status === 500
    || status === 502 || status === 503 || status === 504 || status === 529;
}

function errorMessage(kind: ProviderErrorKind, status: number): string {
  const descriptions: Partial<Record<ProviderErrorKind, string>> = {
    authentication: '模型服务认证失败',
    permission: '模型服务拒绝访问',
    billing: '模型服务账户或额度不可用',
    rate_limit: '模型服务触发限流',
    timeout: '模型服务请求超时',
    upstream: '模型上游服务暂时不可用',
    context_length: '模型上下文超过限制',
    content_filter: '模型请求被内容策略阻止',
    invalid_request: '模型服务无法接受当前请求',
    not_found: '模型服务端点或模型不存在',
  };
  return `${descriptions[kind] ?? '模型请求失败'}：HTTP ${status}`;
}

function codecFor(protocol: OpenAICompatibleProviderOptions['protocol']): ProtocolCodec {
  if (protocol === 'chat_completions') return new ChatCompletionsCodec();
  return new ResponsesCodec();
}
