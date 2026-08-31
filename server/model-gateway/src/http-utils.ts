import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

export class GatewayRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly retryable: boolean,
    message: string,
  ) {
    super(message);
  }
}

export async function readForm(request: IncomingMessage): Promise<Record<string, string>> {
  return Object.fromEntries(new URLSearchParams(await readBody(request, 64 * 1024)).entries());
}

// 请求体上限：先按 content-length 预检(若可信)，再在实际流式累加中复核，
// 防止客户端谎报长度绕过大小限制；超限统一抛 413。
export async function readBody(request: IncomingMessage, limit: number): Promise<string> {
  const declaredLength = Number(request.headers['content-length']);
  if (Number.isFinite(declaredLength) && declaredLength > limit) {
    throw new GatewayRequestError(413, 'request_too_large', false, '请求体超过大小限制');
  }

  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > limit) {
      throw new GatewayRequestError(413, 'request_too_large', false, '请求体超过大小限制');
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export function writeJson(response: ServerResponse, status: number, body: unknown): void {
  if (response.headersSent) return;
  response.statusCode = status;
  response.setHeader('content-type', 'application/json');
  response.end(JSON.stringify(body));
}

export function errorPayload(
  code: string,
  requestId: string,
  retryable: boolean,
  message = 'Gateway 请求失败',
): { error: { code: string; message: string; retryable: boolean }; request_id: string } {
  return { error: { code, message, retryable }, request_id: requestId };
}

// 用户可控字符串拼进 HTML 前必须转义，防止脚本注入 (XSS)；
// 用于 /device 页面里回显的 user_code。
export function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/gu, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    "'": '&#39;',
    '"': '&quot;',
  }[character] ?? character));
}

// 对 secret 做常量时间比较 (timingSafeEqual)。先用 SHA-256 固定摘要长度，
// 避免长度差异与逐位比较带来的时序侧信道；用于 deviceApprovalSecret 校验。
export function secureEquals(left: string, right: string): boolean {
  const leftDigest = createHash('sha256').update(left).digest();
  const rightDigest = createHash('sha256').update(right).digest();
  return timingSafeEqual(leftDigest, rightDigest);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
