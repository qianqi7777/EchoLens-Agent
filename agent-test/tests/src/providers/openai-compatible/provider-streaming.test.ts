import assert from 'node:assert/strict';
import test from 'node:test';
import { textMessage } from '../../../../../src/core/messages.js';
import { ProviderError } from '../../../../../src/providers/provider-error.js';
import type { ProviderStreamEvent } from '../../../../../src/providers/types.js';
import { OpenAICompatibleProvider } from '../../../../../src/providers/openai-compatible/client.js';
import { parseSse } from '../../../../../src/providers/openai-compatible/sse.js';

test('Chat SSE 增量文本与分片工具参数合并为最终结果', async () => {
  let requestBody: Record<string, unknown> | undefined;
  const provider = new OpenAICompatibleProvider({
    model: 'chat-stream-model',
    baseUrl: 'https://provider.example/v1',
    apiKey: 'test-key',
    protocol: 'chat_completions',
    capabilities: { supportsStreaming: true },
    fetch: async (_input, init) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return sseResponse([
        data({ id: 'chat-1', choices: [{ delta: { content: 'Hel' }, finish_reason: null }] }),
        data({
          id: 'chat-1',
          choices: [{
            delta: {
              content: 'lo',
              tool_calls: [{
                index: 0,
                id: 'call-1',
                function: { name: 'read_file', arguments: '{"path":' },
              }],
            },
            finish_reason: null,
          }],
        }),
        data({
          id: 'chat-1',
          choices: [{
            delta: { tool_calls: [{ index: 0, function: { arguments: '"a.ts"}' } }] },
            finish_reason: 'tool_calls',
          }],
        }),
        data({ choices: [], usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } }),
        'data: [DONE]\n\n',
      ]);
    },
  });

  const events = await collect(provider.stream!({ items: [textMessage('user', 'user', 'test')] }));
  const completed = events.find((event) => event.type === 'response.completed');
  assert.equal(requestBody?.stream, true);
  assert.equal(events.filter((event) => event.type === 'output_text.delta')
    .map((event) => event.type === 'output_text.delta' ? event.delta : '').join(''), 'Hello');
  assert.ok(completed?.type === 'response.completed');
  assert.equal(completed.result.stopReason, 'tool_calls');
  const call = completed.result.output.find((item) => item.type === 'tool_call');
  assert.ok(call?.type === 'tool_call');
  assert.deepEqual(call.arguments, { path: 'a.ts' });
  assert.equal(completed.result.usage?.totalTokens, 8);
});

test('Responses SSE 使用 response.completed 解码最终结果', async () => {
  const provider = new OpenAICompatibleProvider({
    model: 'responses-stream-model',
    baseUrl: 'https://provider.example/v1',
    apiKey: 'test-key',
    protocol: 'responses',
    capabilities: { supportsStreaming: true },
    fetch: async () => sseResponse([
      event('response.output_text.delta', { type: 'response.output_text.delta', delta: '完成' }),
      event('response.completed', {
        type: 'response.completed',
        response: {
          id: 'resp-1',
          status: 'completed',
          output: [{
            type: 'message',
            id: 'message-1',
            role: 'assistant',
            content: [{ type: 'output_text', text: '完成' }],
          }],
          usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6 },
        },
      }),
    ]),
  });

  const events = await collect(provider.stream!({ items: [textMessage('user', 'user', 'test')] }));
  const completed = events.find((item) => item.type === 'response.completed');
  assert.ok(completed?.type === 'response.completed');
  assert.equal(completed.result.stopReason, 'completed');
  assert.equal(completed.result.usage?.totalTokens, 6);
});

test('流式连接在输出前按分类重试并发出 retry 事件', async () => {
  let calls = 0;
  const delays: number[] = [];
  const provider = new OpenAICompatibleProvider({
    model: 'retry-stream-model',
    baseUrl: 'https://provider.example/v1',
    apiKey: 'test-key',
    protocol: 'chat_completions',
    capabilities: { supportsStreaming: true },
    retry: { sleep: async (delayMs) => { delays.push(delayMs); } },
    fetch: async () => {
      calls += 1;
      if (calls === 1) {
        return new Response(JSON.stringify({ error: { code: 'rate_limit' } }), {
          status: 429,
          headers: { 'content-type': 'application/json', 'retry-after': '1' },
        });
      }
      return sseResponse([
        data({ id: 'chat-retry', choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }),
        'data: [DONE]\n\n',
      ]);
    },
  });

  const events = await collect(provider.stream!({ items: [textMessage('user', 'user', 'test')] }));
  const retry = events.find((event) => event.type === 'transport.retry');
  const completed = events.find((event) => event.type === 'response.completed');
  assert.deepEqual(retry, { type: 'transport.retry', attempt: 2, delayMs: 1000, code: 'rate_limit' });
  assert.ok(completed?.type === 'response.completed');
  assert.equal(completed.result.transport?.attempts, 2);
  assert.equal(completed.result.transport?.retries, 1);
  assert.equal(calls, 2);
  assert.deepEqual(delays, [1000]);
});

test('已输出增量后流中断不会自动重放', async () => {
  let calls = 0;
  const provider = new OpenAICompatibleProvider({
    model: 'broken-stream-model',
    baseUrl: 'https://provider.example/v1',
    apiKey: 'test-key',
    protocol: 'chat_completions',
    capabilities: { supportsStreaming: true },
    fetch: async () => {
      calls += 1;
      return sseResponse([
        data({ id: 'chat-broken', choices: [{ delta: { content: 'partial' } }] }),
      ]);
    },
  });

  await assert.rejects(
    collect(provider.stream!({ items: [textMessage('user', 'user', 'test')] })),
    (error: unknown) => error instanceof ProviderError
      && error.code === 'response_stream_interrupted'
      && error.retryable === false,
  );
  assert.equal(calls, 1);
});

test('SSE 可解析跨网络分片的 CRLF 事件边界', async () => {
  // 网络分片故意把 CRLF 与事件边界切碎（chunks[1] 以 '\n' 续上 chunks[0] 末尾的 '\r'），
  // 验证解析器按事件重组，而非依赖网络层整行投递。
  const chunks = ['data: first\r', '\n\r', '\ndata: second\r\n\r\n'];
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
      controller.close();
    },
  });

  const records = [];
  for await (const record of parseSse(body)) records.push(record);
  assert.deepEqual(records.map((record) => record.data), ['first', 'second']);
});

async function collect(stream: AsyncIterable<ProviderStreamEvent>): Promise<ProviderStreamEvent[]> {
  const events: ProviderStreamEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

function sseResponse(blocks: string[]): Response {
  const encoded = new TextEncoder().encode(blocks.join(''));
  const midpoint = Math.max(1, Math.floor(encoded.length / 2));
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoded.slice(0, midpoint));
      controller.enqueue(encoded.slice(midpoint));
      controller.close();
    },
  }), {
    status: 200,
    headers: { 'content-type': 'text/event-stream', 'x-request-id': 'request-stream' },
  });
}

function data(value: unknown): string {
  return `data: ${JSON.stringify(value)}\n\n`;
}

function event(name: string, value: unknown): string {
  return `event: ${name}\ndata: ${JSON.stringify(value)}\n\n`;
}
