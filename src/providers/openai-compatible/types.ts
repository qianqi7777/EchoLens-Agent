import type { ProviderCapabilities, ProviderRequest, ProviderResult } from '../types.js';
import type { RetryPolicyOverrides } from '../retry-policy.js';

// 两个 OpenAI 兼容 HTTP 协议；上层按此值选择具体 codec 与流式解码路径。
export type OpenAICompatibleProtocol = 'chat_completions' | 'responses';

export interface EncodedProviderRequest {
  endpoint: '/chat/completions' | '/responses';
  body: Record<string, unknown>;
}

/**
 * Provider 边界接口：encode 把内部请求编成对应协议的 HTTP body，decode 把不可信的
 * 响应或流终止载荷解码为内部结果。decode 对畸形载荷抛错，调用方依据 stopReason 决定重试。
 */
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
