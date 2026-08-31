import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';

export interface OpenApiMockSelection {
  status?: number;
  example?: string;
  headers?: Record<string, string>;
}

export interface OpenApiMockRequest {
  method: string;
  path: string;
  authorization?: string;
  body?: unknown;
}

/**
 * 网关测试替身：契约来自 contracts/gateway.openapi.json，只按文档里的 operation
 * 与 example 应答，不访问真实网络，让 Gateway 客户端测试获得可断言的本地端点。
 * 与生产网关的刻意差异：authorization 头只记录不校验，x-request-id 是
 * mock-<序号> 而非生产格式。
 */
export async function startGatewayOpenApiMock(
  selections: Record<string, OpenApiMockSelection> = {},
) {
  const contractPath = resolve(process.cwd(), 'contracts', 'gateway.openapi.json');
  const document = JSON.parse(await readFile(contractPath, 'utf8')) as OpenApiDocument;
  const requests: OpenApiMockRequest[] = [];
  const server = createServer((request, response) => {
    void handleRequest(document, selections, requests, request)
      .then((mock) => {
        response.statusCode = mock.status;
        response.setHeader('x-request-id', `mock-${requests.length}`);
        for (const [name, value] of Object.entries(mock.headers)) response.setHeader(name, value);
        if (mock.body === undefined) response.end();
        else {
          response.setHeader('content-type', 'application/json');
          response.end(JSON.stringify(mock.body));
        }
      })
      .catch((error) => {
        response.statusCode = 500;
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
      });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    close: async () => {
      server.close();
      await once(server, 'close');
    },
  };
}

async function handleRequest(
  document: OpenApiDocument,
  selections: Record<string, OpenApiMockSelection>,
  requests: OpenApiMockRequest[],
  request: IncomingMessage,
) {
  const method = (request.method ?? 'GET').toUpperCase();
  const path = new URL(request.url ?? '/', 'http://mock.local').pathname;
  const key = `${method} ${path}`;
  // 原始请求（含 authorization 头）全部入列，供测试事后断言客户端实际发出的
// 内容与凭据头；这里不做任何鉴权校验，是刻意保持的测试替身差异。
  requests.push({
    method,
    path,
    authorization: request.headers.authorization,
    body: await requestBody(request),
  });

  const operation = document.paths[path]?.[method.toLowerCase()];
  if (!operation) return { status: 404, headers: {}, body: { error: `No OpenAPI operation for ${key}` } };

  const selection = selections[key] ?? {};
  // 未显式指定状态码时默认取文档中第一个 2xx；测试可用 selections 按
  // `${method} ${path}` 精确覆盖状态码、示例名与响应头。
  const status = selection.status ?? firstSuccessStatus(operation.responses);
  const unresolved = operation.responses[String(status)];
  if (!unresolved) throw new Error(`OpenAPI response ${status} is missing for ${key}`);
  const response = resolveReference(document, unresolved);
  const media = response.content?.['application/json'];
  if (!media) return { status, headers: selection.headers ?? {}, body: undefined };
  const body = selectedExample(media, selection.example);
  return { status, headers: selection.headers ?? {}, body };
}

async function requestBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  if (chunks.length === 0) return undefined;
  const body = Buffer.concat(chunks).toString('utf8');
  if (request.headers['content-type']?.includes('application/json')) {
    try {
      return JSON.parse(body) as unknown;
    } catch {
      return body;
    }
  }
  return body;
}

function firstSuccessStatus(responses: Record<string, OpenApiResponse | OpenApiReference>): number {
  const value = Object.keys(responses).find((status) => /^2\d\d$/.test(status));
  if (!value) throw new Error('OpenAPI operation has no success response');
  return Number(value);
}

function resolveReference(document: OpenApiDocument, value: OpenApiResponse | OpenApiReference): OpenApiResponse {
  if (!('$ref' in value)) return value;
  const segments = value.$ref.replace(/^#\//, '').split('/');
  let current: unknown = document;
  for (const segment of segments) {
    if (!isRecord(current)) throw new Error(`Invalid OpenAPI reference: ${value.$ref}`);
    current = current[segment];
  }
  if (!isRecord(current)) throw new Error(`Invalid OpenAPI response reference: ${value.$ref}`);
  return current as OpenApiResponse;
}

// 选取优先级：命名的 examples 项 > 顶层 example > 第一个 examples 项；
// 全部缺失时抛错，避免 mock 在测试中途静默返回空 body。
function selectedExample(media: OpenApiMedia, name?: string): unknown {
  if (name) {
    const selected = media.examples?.[name];
    if (!selected || !('value' in selected)) throw new Error(`OpenAPI example is missing: ${name}`);
    return selected.value;
  }
  if (media.example !== undefined) return media.example;
  const first = media.examples ? Object.values(media.examples)[0] : undefined;
  if (first && 'value' in first) return first.value;
  throw new Error('OpenAPI response has no example');
}

interface OpenApiDocument {
  paths: Record<string, Record<string, OpenApiOperation>>;
  components?: Record<string, unknown>;
}

interface OpenApiOperation {
  responses: Record<string, OpenApiResponse | OpenApiReference>;
}

interface OpenApiReference {
  $ref: string;
}

interface OpenApiResponse {
  content?: Record<string, OpenApiMedia>;
}

interface OpenApiMedia {
  example?: unknown;
  examples?: Record<string, { value?: unknown }>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
