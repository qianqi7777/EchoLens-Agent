import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { textMessage } from '../../core/messages.js';
import { ProviderError } from '../provider-error.js';
import { redactHeaders, redactUrl, redactValue } from '../redaction.js';
import { OpenAICompatibleProvider } from './client.js';
import type { OpenAICompatibleProviderOptions } from './types.js';

test('429 honors Retry-After and succeeds on the next attempt', async () => {
  let calls = 0;
  const delays: number[] = [];
  const server = await statusServer((response) => {
    calls += 1;
    response.setHeader('content-type', 'application/json');
    if (calls === 1) {
      response.statusCode = 429;
      response.setHeader('retry-after', '1');
      response.end(JSON.stringify({ error: { code: 'rate_limit', message: 'slow down' } }));
      return;
    }
    response.end(successPayload());
  });

  try {
    const provider = providerFor(server.baseUrl, {
      retry: { sleep: async (delayMs) => { delays.push(delayMs); } },
    });
    const result = await provider.complete({ items: [textMessage('user-1', 'user', 'hello')] });
    assert.equal(result.stopReason, 'completed');
    assert.equal(result.transport?.attempts, 2);
    assert.equal(result.transport?.retries, 1);
    assert.equal(calls, 2);
    assert.deepEqual(delays, [1000]);
  } finally {
    await server.close();
  }
});

test('transient 5xx stops after the configured retry budget', async () => {
  let calls = 0;
  const server = await statusServer((response) => {
    calls += 1;
    response.statusCode = 503;
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ error: { code: 'overloaded', message: 'unavailable' } }));
  });

  try {
    const provider = providerFor(server.baseUrl, {
      retry: { maxRetries: 2, sleep: async () => {}, random: () => 0 },
    });
    await assert.rejects(
      provider.complete({ items: [textMessage('user-1', 'user', 'hello')] }),
      (error: unknown) => {
        assert.ok(error instanceof ProviderError);
        assert.equal(error.kind, 'upstream');
        assert.equal(error.retryable, true);
        assert.equal(error.attempts, 3);
        return true;
      },
    );
    assert.equal(calls, 3);
  } finally {
    await server.close();
  }
});

test('a transient network error retries without changing protocol', async () => {
  let calls = 0;
  const paths: string[] = [];
  const fetchImplementation: typeof fetch = async (input) => {
    calls += 1;
    paths.push(String(input));
    if (calls === 1) throw new TypeError('temporary connection failure');
    return new Response(successPayload(), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  const provider = providerFor('https://provider.invalid/v1', {
    fetch: fetchImplementation,
    retry: { sleep: async () => {} },
  });

  const result = await provider.complete({ items: [textMessage('user-1', 'user', 'hello')] });
  assert.equal(result.transport?.attempts, 2);
  assert.equal(calls, 2);
  assert.deepEqual(paths, [
    'https://provider.invalid/v1/chat/completions',
    'https://provider.invalid/v1/chat/completions',
  ]);
});

test('401 is not retried and provider errors do not expose credentials', async () => {
  let calls = 0;
  const secret = 'sk-super-secret-value';
  const server = await statusServer((response) => {
    calls += 1;
    response.statusCode = 401;
    response.setHeader('content-type', 'application/json');
    // 攻击样本：服务端把客户端发出的 Authorization 头拼进错误消息回显，模拟不可信 Provider 反射凭据。
    // 不变量：ProviderError 的 JSON 序列化及 error.cause 均不得包含该凭据。
    response.end(JSON.stringify({
      error: {
        code: 'invalid_api_key',
        type: 'authentication_error',
        message: `Authorization: Bearer ${secret}`,
      },
    }));
  });

  try {
    const provider = providerFor(server.baseUrl, {
      retry: { sleep: async () => { throw new Error('must not retry'); } },
    });
    await assert.rejects(
      provider.complete({ items: [textMessage('user-1', 'user', 'hello')] }),
      (error: unknown) => {
        assert.ok(error instanceof ProviderError);
        assert.equal(error.kind, 'authentication');
        assert.equal(error.retryable, false);
        assert.equal(JSON.stringify(error), JSON.stringify(error.toJSON()));
        assert.equal(JSON.stringify(error).includes(secret), false);
        assert.equal(String(JSON.stringify(error.cause)).includes(secret), false);
        return true;
      },
    );
    assert.equal(calls, 1);
  } finally {
    await server.close();
  }
});

test('cancelling during backoff stops before another request', async () => {
  let calls = 0;
  let enteredBackoff!: () => void;
  const backoffStarted = new Promise<void>((resolve) => { enteredBackoff = resolve; });
  const server = await statusServer((response) => {
    calls += 1;
    response.statusCode = 429;
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ error: { code: 'rate_limit' } }));
  });

  try {
    const controller = new AbortController();
    const provider = providerFor(server.baseUrl, {
      // 竞态窗口：待 sleep 真正进入退避（已收到 429、尚未发出下一次请求）后再 abort，
      // 以确定性的方式覆盖“退避中被取消”的分支，并验证不再发起任何后续请求。
      retry: {
        sleep: async (_delayMs, signal) => {
          enteredBackoff();
          await new Promise<void>((_resolve, reject) => {
            signal?.addEventListener(
              'abort',
              () => reject(new DOMException('Aborted', 'AbortError')),
              { once: true },
            );
          });
        },
      },
    });
    const completion = provider.complete({
      items: [textMessage('user-1', 'user', 'hello')],
      signal: controller.signal,
    });
    await backoffStarted;
    controller.abort();
    await assert.rejects(completion, (error: unknown) => {
      assert.ok(error instanceof ProviderError);
      assert.equal(error.kind, 'cancelled');
      assert.equal(error.attempts, 1);
      return true;
    });
    assert.equal(calls, 1);
  } finally {
    await server.close();
  }
});

test('a response body interruption is classified but never replayed', async () => {
  let calls = 0;
  // 恶意样本：响应体发出合法前缀后以网络错误中断，且错误消息内嵌凭据，
  // 模拟被截断并可能被注入敏感信息的网络流。不变量：部分响应绝不重放（calls 为 1），
  // 中断原因中的凭据也不得进入 ProviderError 序列化。
  const fetchImplementation: typeof fetch = async () => {
    calls += 1;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"choices":['));
        controller.error(new Error('socket interrupted with Bearer sk-hidden-secret'));
      },
    });
    return new Response(body, {
      status: 200,
      headers: { 'content-type': 'application/json', 'x-request-id': 'request-stream' },
    });
  };
  const provider = providerFor('https://provider.invalid/v1', {
    fetch: fetchImplementation,
    retry: { sleep: async () => {} },
  });

  await assert.rejects(
    provider.complete({ items: [textMessage('user-1', 'user', 'hello')] }),
    (error: unknown) => {
      assert.ok(error instanceof ProviderError);
      assert.equal(error.kind, 'protocol');
      assert.equal(error.retryable, false);
      assert.equal(error.requestId, 'request-stream');
      assert.equal(JSON.stringify(error).includes('sk-hidden-secret'), false);
      return true;
    },
  );
  assert.equal(calls, 1);
});

test('context limits and content filtering have distinct error kinds', async () => {
  const contextProvider = providerFor('https://provider.invalid/v1', {
    fetch: async () => new Response(JSON.stringify({
      error: { code: 'context_length_exceeded', message: 'maximum context length exceeded' },
    }), { status: 400, headers: { 'content-type': 'application/json' } }),
    retry: { maxRetries: 0 },
  });
  const contentProvider = providerFor('https://provider.invalid/v1', {
    fetch: async () => new Response(JSON.stringify({
      error: { code: 'content_filter', message: 'blocked by safety policy' },
    }), { status: 400, headers: { 'content-type': 'application/json' } }),
    retry: { maxRetries: 0 },
  });

  await assert.rejects(
    contextProvider.complete({ items: [textMessage('user-1', 'user', 'hello')] }),
    (error: unknown) => error instanceof ProviderError && error.kind === 'context_length',
  );
  await assert.rejects(
    contentProvider.complete({ items: [textMessage('user-1', 'user', 'hello')] }),
    (error: unknown) => error instanceof ProviderError && error.kind === 'content_filter',
  );
});

test('request deadlines are classified as retryable timeouts', async () => {
  const provider = providerFor('https://provider.invalid/v1', {
    requestTimeoutMs: 5,
    retry: { maxRetries: 0 },
    // fetch 永不自行结束，只有内部 deadline 触发的 abort 能终止它，
    // 从而单独覆盖“请求超时被归为可重试错误（timeout）”的分支。
    fetch: async (_input, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener(
        'abort',
        () => reject(new DOMException('Aborted', 'AbortError')),
        { once: true },
      );
    }),
  });

  await assert.rejects(
    provider.complete({ items: [textMessage('user-1', 'user', 'hello')] }),
    (error: unknown) => {
      assert.ok(error instanceof ProviderError);
      assert.equal(error.kind, 'timeout');
      assert.equal(error.retryable, true);
      assert.equal(error.attempts, 1);
      return true;
    },
  );
});

test('redaction handles headers, query strings, nested values, and errors', () => {
  const secret = 'sk-another-secret-value';
  const headers = redactHeaders({
    authorization: `Bearer ${secret}`,
    cookie: `session=${secret}`,
    'x-note': `token=${secret}`,
  });
  const url = redactUrl(`https://user:${secret}@example.test/v1?api_key=${secret}&model=test`);
  const value = redactValue({
    apiKey: secret,
    token: 'short-secret',
    nested: { message: `Bearer ${secret}` },
    error: new Error(`access_token=${secret}`),
  });

  const serialized = JSON.stringify({ headers, url, value });
  assert.equal(serialized.includes(secret), false);
  assert.equal(serialized.includes('short-secret'), false);
  assert.equal(serialized.includes('[REDACTED]') || serialized.includes('%5BREDACTED%5D'), true);
});

function providerFor(baseUrl: string, overrides: Partial<OpenAICompatibleProviderOptions> = {}) {
  return new OpenAICompatibleProvider({
    model: 'test-model',
    baseUrl,
    apiKey: 'test-key',
    protocol: 'chat_completions',
    ...overrides,
  });
}

function successPayload(): string {
  return JSON.stringify({
    id: 'chat-success',
    choices: [{ finish_reason: 'stop', message: { content: 'ok' } }],
  });
}

async function statusServer(handler: (response: ServerResponse) => void) {
  const server = createServer((_request, response) => handler(response));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    close: async () => {
      server.close();
      await once(server, 'close');
    },
  };
}
