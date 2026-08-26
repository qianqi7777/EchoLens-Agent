import { Transform } from 'node:stream';
import type { GatewayProtocol } from './types.js';
import { GatewayRequestError, isRecord } from './http-utils.js';

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
}

export function emptyTokenUsage(): TokenUsage {
  return { inputTokens: 0, outputTokens: 0, cachedTokens: 0 };
}

export function usageFromJson(value: unknown): TokenUsage {
  if (!isRecord(value) || !isRecord(value.usage)) return emptyTokenUsage();
  const usage = value.usage;
  return {
    inputTokens: numberValue(usage.input_tokens) ?? numberValue(usage.prompt_tokens) ?? 0,
    outputTokens: numberValue(usage.output_tokens) ?? numberValue(usage.completion_tokens) ?? 0,
    cachedTokens: numberValue(isRecord(usage.input_tokens_details) ? usage.input_tokens_details.cached_tokens : undefined)
      ?? numberValue(usage.prompt_cache_hit_tokens) ?? 0,
  };
}

export function createUsageInspector(
  protocol: GatewayProtocol,
  responseLimit: number,
  onUsage: (usage: TokenUsage) => void,
): Transform {
  const chunks: Buffer[] = [];
  const maxUsageCapture = Math.min(responseLimit, 2 * 1024 * 1024);
  let captured = 0;
  let total = 0;

  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      const buffer = Buffer.from(chunk);
      total += buffer.byteLength;
      if (total > responseLimit) {
        callback(new GatewayRequestError(
          502,
          'upstream_response_too_large',
          false,
          '上游响应超过大小限制',
        ));
        return;
      }
      if (captured < maxUsageCapture) {
        const remaining = maxUsageCapture - captured;
        chunks.push(buffer.subarray(0, remaining));
        captured += Math.min(buffer.byteLength, remaining);
      }
      callback(null, buffer);
    },
    flush(callback) {
      onUsage(usageFromSse(Buffer.concat(chunks).toString('utf8'), protocol));
      callback();
    },
  });
}

export async function readLimitedResponse(response: Response, limit: number): Promise<Buffer> {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      total += chunk.byteLength;
      if (total > limit) {
        await reader.cancel('upstream_response_too_large');
        throw new GatewayRequestError(
          502,
          'upstream_response_too_large',
          false,
          '上游响应超过大小限制',
        );
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }

  return Buffer.concat(chunks);
}

export function sanitizedBody(value: Record<string, unknown>): string {
  const copy = structuredClone(value);
  for (const field of [
    'api_key',
    'authorization',
    'base_url',
    'endpoint',
    'headers',
    'provider_url',
    'upstream_url',
  ]) delete copy[field];
  return JSON.stringify(copy);
}

function usageFromSse(text: string, protocol: GatewayProtocol): TokenUsage {
  let usage = emptyTokenUsage();
  for (const line of text.split(/\r?\n/u)) {
    if (!line.startsWith('data:')) continue;
    const data = line.slice('data:'.length).trim();
    if (!data || data === '[DONE]') continue;
    try {
      const value = JSON.parse(data) as unknown;
      const candidate = protocol === 'responses' && isRecord(value) && isRecord(value.response)
        ? usageFromJson(value.response)
        : usageFromJson(value);
      if (candidate.inputTokens || candidate.outputTokens || candidate.cachedTokens) usage = candidate;
    } catch {
      // Invalid events remain byte-transparent and contribute no usage.
    }
  }
  return usage;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}
