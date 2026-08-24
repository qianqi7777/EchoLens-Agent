import type { ProviderCapabilities, ProviderRequest, ProviderResult } from '../types.js';
import type { RetryPolicyOverrides } from '../retry-policy.js';

export type OpenAICompatibleProtocol = 'chat_completions' | 'responses';

export interface EncodedProviderRequest {
  endpoint: '/chat/completions' | '/responses';
  body: Record<string, unknown>;
}

export interface ProtocolCodec {
  readonly protocol: OpenAICompatibleProtocol;
  encode(model: string, request: ProviderRequest): EncodedProviderRequest;
  decode(payload: unknown, requestId?: string): ProviderResult;
}

export interface OpenAICompatibleProviderOptions {
  model: string;
  baseUrl: string;
  apiKey: string;
  protocol: OpenAICompatibleProtocol;
  capabilities?: Partial<ProviderCapabilities>;
  fetch?: typeof globalThis.fetch;
  requestTimeoutMs?: number;
  retry?: RetryPolicyOverrides;
}
