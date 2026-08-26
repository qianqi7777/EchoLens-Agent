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

export function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/gu, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    "'": '&#39;',
    '"': '&quot;',
  }[character] ?? character));
}

export function secureEquals(left: string, right: string): boolean {
  const leftDigest = createHash('sha256').update(left).digest();
  const rightDigest = createHash('sha256').update(right).digest();
  return timingSafeEqual(leftDigest, rightDigest);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
