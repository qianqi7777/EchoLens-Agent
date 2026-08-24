import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { textMessage, type ConversationItem, type ToolResultItem } from '../../core/messages.js';
import { ProviderError } from '../provider-error.js';
import type { ModelToolDefinition } from '../types.js';
import { OpenAICompatibleProvider } from './client.js';

const tools: ModelToolDefinition[] = [{
  name: 'read_file',
  description: '读取文件',
  parameters: {
    type: 'object',
    properties: { path: { type: 'string' } },
    required: ['path'],
    additionalProperties: false,
  },
}];

test('Chat Completions codec preserves multiple tool calls and correlates tool results', async () => {
  const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
  let call = 0;
  const server = await startTestServer(async (request, response) => {
    requests.push({ path: request.url ?? '', body: await jsonBody(request) });
    call += 1;
    response.setHeader('content-type', 'application/json');
    response.setHeader('x-request-id', `request-${call}`);
    if (call === 1) {
      response.end(JSON.stringify({
        id: 'chat-1',
        choices: [{
          finish_reason: 'tool_calls',
          message: {
            content: null,
            tool_calls: [
              { id: 'call-1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.ts"}' } },
              { id: 'call-2', type: 'function', function: { name: 'read_file', arguments: '{invalid' } },
            ],
          },
        }],
        usage: {
          prompt_tokens: 12,
          completion_tokens: 8,
          total_tokens: 20,
          prompt_cache_hit_tokens: 5,
        },
      }));
      return;
    }
    response.end(JSON.stringify({
      id: 'chat-2',
      choices: [{ finish_reason: 'stop', message: { content: '完成。' } }],
    }));
  });

  try {
    const provider = providerFor(server.baseUrl, 'chat_completions');
    const first = await provider.complete({
      items: [textMessage('user-1', 'user', '读取两个文件')],
      tools,
    });
    assert.equal(first.stopReason, 'tool_calls');
    assert.equal(first.requestId, 'request-1');
    assert.equal(first.output.filter((item) => item.type === 'tool_call').length, 2);
    assert.equal(first.usage?.cachedInputTokens, 5);
    const invalidCall = first.output.find(
      (item) => item.type === 'tool_call' && item.callId === 'call-2',
    );
    assert.ok(invalidCall?.type === 'tool_call');
    assert.equal(invalidCall.argumentParseError, '工具参数不是合法 JSON');

    const items: ConversationItem[] = [
      textMessage('user-1', 'user', '读取两个文件'),
      ...first.output,
      toolResult('result-1', 'call-1', 'a.ts content'),
      toolResult('result-2', 'call-2', 'invalid arguments'),
    ];
    const second = await provider.complete({ items, tools });
    assert.equal(second.stopReason, 'completed');

    assert.equal(requests[0]?.path, '/v1/chat/completions');
    assert.equal(requests[1]?.path, '/v1/chat/completions');
    assert.equal('temperature' in requests[0]!.body, false);
    const secondMessages = requests[1]?.body.messages as Array<Record<string, unknown>>;
    const assistant = secondMessages[1]!;
    assert.equal(assistant.role, 'assistant');
    assert.equal((assistant.tool_calls as unknown[]).length, 2);
    assert.equal(secondMessages[2]?.tool_call_id, 'call-1');
    assert.equal(secondMessages[3]?.tool_call_id, 'call-2');
  } finally {
    await server.close();
  }
});

test('Responses codec maps function call items, empty messages, usage, and tool outputs', async () => {
  const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
  let call = 0;
  const server = await startTestServer(async (request, response) => {
    requests.push({ path: request.url ?? '', body: await jsonBody(request) });
    call += 1;
    response.setHeader('content-type', 'application/json');
    response.setHeader('x-request-id', `response-request-${call}`);
    if (call === 1) {
      response.end(JSON.stringify({
        id: 'resp-1',
        status: 'completed',
        output: [
          { type: 'message', id: 'msg-1', role: 'assistant', content: [] },
          { type: 'function_call', id: 'fc-1', call_id: 'call-1', name: 'read_file', arguments: '{"path":"a.ts"}' },
        ],
        usage: {
          input_tokens: 10,
          output_tokens: 4,
          total_tokens: 14,
          input_tokens_details: { cached_tokens: 3 },
        },
      }));
      return;
    }
    response.end(JSON.stringify({
      id: 'resp-2',
      status: 'completed',
      output: [{
        type: 'message',
        id: 'msg-2',
        role: 'assistant',
        content: [{ type: 'output_text', text: '已读取。' }],
      }],
    }));
  });

  try {
    const provider = providerFor(server.baseUrl, 'responses');
    const first = await provider.complete({
      items: [textMessage('user-1', 'user', '读取文件')],
      tools,
    });
    assert.equal(first.stopReason, 'tool_calls');
    assert.equal(first.requestId, 'response-request-1');
    assert.equal(first.usage?.cachedInputTokens, 3);
    assert.equal(first.output[0]?.type, 'message');
    assert.equal(first.output[1]?.type, 'tool_call');

    const second = await provider.complete({
      items: [
        textMessage('user-1', 'user', '读取文件'),
        ...first.output,
        toolResult('result-1', 'call-1', 'a.ts content'),
      ],
      tools,
    });
    assert.equal(second.stopReason, 'completed');
    assert.equal(requests[0]?.path, '/v1/responses');
    assert.equal(requests[1]?.path, '/v1/responses');
    assert.equal('parallel_tool_calls' in requests[0]!.body, false);
    const input = requests[1]?.body.input as Array<Record<string, unknown>>;
    assert.equal(input.some((item) => item.type === 'function_call'), true);
    assert.equal(input.some((item) => item.type === 'function_call_output'), true);
  } finally {
    await server.close();
  }
});

test('an explicit protocol never falls back to the other endpoint', async () => {
  const paths: string[] = [];
  const server = await startTestServer(async (request, response) => {
    paths.push(request.url ?? '');
    response.statusCode = 404;
    response.end('not found');
  });

  try {
    const provider = providerFor(server.baseUrl, 'responses');
    await assert.rejects(
      provider.complete({ items: [textMessage('user-1', 'user', 'hello')] }),
      /HTTP 404/,
    );
    assert.deepEqual(paths, ['/v1/responses']);
  } finally {
    await server.close();
  }
});

test('malformed successful payloads fail as protocol errors for both protocols', async () => {
  const server = await startTestServer(async (_request, response) => {
    response.setHeader('content-type', 'application/json');
    response.end('{}');
  });

  try {
    for (const protocol of ['chat_completions', 'responses'] as const) {
      await assert.rejects(
        providerFor(server.baseUrl, protocol).complete({
          items: [textMessage(`user-${protocol}`, 'user', 'hello')],
        }),
        (error: unknown) => {
          assert.ok(error instanceof ProviderError);
          assert.equal(error.kind, 'protocol');
          assert.equal(error.code, 'provider_protocol_mismatch');
          return true;
        },
      );
    }
  } finally {
    await server.close();
  }
});

test('non-terminal Responses states are not reported as completed', async () => {
  const server = await startTestServer(async (_request, response) => {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ id: 'queued-1', status: 'queued', output: [] }));
  });

  try {
    const result = await providerFor(server.baseUrl, 'responses').complete({
      items: [textMessage('user-queued', 'user', 'hello')],
    });
    assert.equal(result.stopReason, 'retryable_error');
  } finally {
    await server.close();
  }
});

function providerFor(baseUrl: string, protocol: 'chat_completions' | 'responses') {
  return new OpenAICompatibleProvider({
    model: 'test-model',
    baseUrl: `${baseUrl}/v1`,
    apiKey: 'test-key',
    protocol,
  });
}

function toolResult(id: string, callId: string, content: string): ToolResultItem {
  return {
    type: 'tool_result',
    id,
    callId,
    toolName: 'read_file',
    status: 'ok',
    output: {
      id: `context-${id}`,
      kind: 'tool_output',
      content,
      source: { type: 'tool', toolCallId: callId, toolName: 'read_file' },
      trust: 'untrusted',
      redactions: [],
    },
    summary: 'ok',
    evidenceIds: [],
  };
}

async function jsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
}

async function startTestServer(
  handler: (request: IncomingMessage, response: ServerResponse) => Promise<void>,
) {
  const server = createServer((request, response) => {
    void handler(request, response).catch((error) => {
      response.statusCode = 500;
      response.end(error instanceof Error ? error.message : String(error));
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: async () => {
      server.close();
      await once(server, 'close');
    },
  };
}
