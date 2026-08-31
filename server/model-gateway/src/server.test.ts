import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { textMessage } from '../../../src/core/messages.js';
import { OpenAICompatibleProvider } from '../../../src/providers/openai-compatible/client.js';
import { startGatewayServer } from './server.js';
import { GatewayStateStore } from './state-store.js';
import type { GatewayModel, GatewayServerHandle } from './types.js';

const model: GatewayModel = {
  id: 'deepseek-chat',
  protocols: ['chat_completions'],
  default_protocol: 'chat_completions',
  capabilities: {
    max_context_tokens: 64_000,
    supports_streaming: true,
    supports_tool_calls: true,
    supports_parallel_tool_calls: true,
    supports_structured_output: false,
    supports_prompt_caching: true,
    supports_usage_reporting: true,
  },
};

test('Gateway Device Flow、固定上游代理、模型目录和注销闭环', async (context) => {
  const upstream = createServer((request, response) => {
    // 上游只认可固定的 upstream apiKey：客户端 access token 不得透传到上游，凭据替换发生在 Gateway 边界。
    assert.equal(request.headers.authorization, 'Bearer upstream-secret');
    assert.equal(request.headers['x-request-id'] !== undefined, true);
    response.writeHead(200, { 'content-type': 'application/json', 'x-request-id': 'upstream-1' });
    response.end(JSON.stringify({ id: 'chat-1', choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'ok' } }], usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } }));
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const address = upstream.address();
  assert.ok(address && typeof address !== 'string');
  const gateway = await startGatewayServer({
    port: 0,
    devicePollingIntervalSeconds: 0,
    models: [model],
    upstreams: { [model.id]: { baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: 'upstream-secret', protocol: 'chat_completions' } },
    randomToken: (() => { let n = 0; return () => `token-${++n}`; })(),
  });
  context.after(async () => { await gateway.close(); upstream.close(); await once(upstream, 'close'); });

  const device = await fetch(`${gateway.baseUrl}/oauth/device/authorization`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'client_id=echolens-cli&scope=models%3Aread%20inference%3Acreate%20account%3Aread%20usage%3Aread',
  });
  const devicePayload = await device.json() as { device_code: string };
  assert.equal(device.status, 200);
  assert.equal((await fetch(`${gateway.baseUrl}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code&device_code=${devicePayload.device_code}&client_id=echolens-cli` })).status, 400);
  assert.equal(gateway.approveDeviceCode(devicePayload.device_code), true);
  const tokenResponse = await fetch(`${gateway.baseUrl}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code&device_code=${devicePayload.device_code}&client_id=echolens-cli` });
  const token = await tokenResponse.json() as { access_token: string; refresh_token: string };
  assert.equal(tokenResponse.status, 200, JSON.stringify(token));

  const models = await fetch(`${gateway.baseUrl}/v1/models`, { headers: { authorization: `Bearer ${token.access_token}` } });
  assert.equal(models.status, 200);
  assert.equal((await models.json() as { data: GatewayModel[] }).data[0]?.id, model.id);

  const inference = await fetch(`${gateway.baseUrl}/v1/chat/completions`, {
    method: 'POST', headers: { authorization: `Bearer ${token.access_token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: model.id, messages: [{ role: 'user', content: 'hello' }], stream: false }),
  });
  assert.equal(inference.status, 200);
  assert.equal((await inference.json() as { choices: Array<{ message: { content: string } }> }).choices[0]?.message.content, 'ok');

  const revoke = await fetch(`${gateway.baseUrl}/oauth/revoke`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `token=${token.access_token}` });
  assert.equal(revoke.status, 200);
  assert.equal((await fetch(`${gateway.baseUrl}/v1/models`, { headers: { authorization: `Bearer ${token.access_token}` } })).status, 401);
});

test('Gateway 不接受客户端传入的任意上游地址', async (context) => {
  const gateway = await startGatewayServer({
    port: 0,
    models: [model],
    upstreams: { [model.id]: { baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'secret', protocol: 'chat_completions' } },
    randomToken: () => 'stable-token',
  });
  context.after(() => gateway.close());
  const device = await fetch(`${gateway.baseUrl}/oauth/device/authorization`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'client_id=echolens-cli' });
  const { device_code } = await device.json() as { device_code: string };
  gateway.approveDeviceCode(device_code);
  const token = await fetch(`${gateway.baseUrl}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code&device_code=${device_code}&client_id=echolens-cli` }).then((response) => response.json()) as { access_token: string };
  // 攻击样本：客户端在请求体注入 base_url 指向云元数据地址（169.254.169.254），试图让 Gateway 转发到内网元数据端点。
  // 验证 Gateway 忽略客户端指定的上游地址，转发目标只能来自服务端 upstreams 配置。
  const response = await fetch(`${gateway.baseUrl}/v1/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${token.access_token}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: model.id, base_url: 'http://169.254.169.254/latest', messages: [] }) });
  assert.notEqual(response.status, 200);
});

test('Gateway 透明转发 Responses SSE 且不改写事件边界', async (context) => {
  const upstream = createServer((request, response) => {
    assert.equal(request.url, '/v1/responses');
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write('event: response.output_text.delta\n');
    response.write('data: {"type":"response.output_text.delta","delta":"A"}\n\n');
    response.write('event: response.completed\n');
    response.end('data: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":5,"output_tokens":2,"total_tokens":7}}}\n\n');
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const address = upstream.address();
  assert.ok(address && typeof address !== 'string');
  const responsesModel: GatewayModel = {
    ...model,
    protocols: ['responses'],
    default_protocol: 'responses',
    capabilities: { ...model.capabilities, supports_structured_output: true },
  };
  const gateway = await startGatewayServer({
    port: 0,
    devicePollingIntervalSeconds: 0,
    models: [responsesModel],
    upstreams: {
      [`${responsesModel.id}:responses`]: {
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        apiKey: 'upstream-secret',
        protocol: 'responses',
      },
    },
    randomToken: (() => { let n = 0; return () => `responses-token-${++n}`; })(),
  });
  context.after(async () => { await gateway.close(); upstream.close(); await once(upstream, 'close'); });
  const device = await fetch(`${gateway.baseUrl}/oauth/device/authorization`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'client_id=echolens-cli' }).then((response) => response.json()) as { device_code: string };
  gateway.approveDeviceCode(device.device_code);
  const token = await fetch(`${gateway.baseUrl}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `grant_type=${encodeURIComponent('urn:ietf:params:oauth:grant-type:device_code')}&device_code=${device.device_code}&client_id=echolens-cli` }).then((response) => response.json()) as { access_token: string };
  const response = await fetch(`${gateway.baseUrl}/v1/responses`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token.access_token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: responsesModel.id, input: [{ role: 'user', content: 'hello' }], stream: true }),
  });
  assert.equal(response.status, 200);
  // 断言透传字节与上游完全一致：跨多次 write 的分片顺序、事件定界符不得被改写；
  // 用量统计可以并行解析 SSE，但不能影响转发字节。
  assert.equal(await response.text(), 'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"A"}\n\nevent: response.completed\ndata: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":5,"output_tokens":2,"total_tokens":7}}}\n\n');
  const usage = await fetch(`${gateway.baseUrl}/v1/usage`, { headers: { authorization: `Bearer ${token.access_token}` } }).then((value) => value.json()) as { inputTokens: number; outputTokens: number };
  assert.deepEqual({ input: usage.inputTokens, output: usage.outputTokens }, { input: 5, output: 2 });
});

test('SQLite 状态跨重启恢复且数据库不保存原始 Token', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'echolens-gateway-state-'));
  const databasePath = join(root, 'gateway.sqlite');
  context.after(() => rm(root, { recursive: true, force: true }));
  const options = {
    port: 0,
    models: [model],
    upstreams: { [model.id]: { baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'secret', protocol: 'chat_completions' as const } },
  };
  const first = await startGatewayServer({ ...options, stateStore: new GatewayStateStore(databasePath) });
  const token = await issueToken(first, 'acct-persist');
  await first.close();
  // 先关闭服务器再读库文件，确保 Token 写入已刷入 SQLite；断言原始 access/refresh token 不以明文落盘。
  const databaseBytes = await readFile(databasePath);
  assert.equal(databaseBytes.includes(Buffer.from(token.access_token)), false);
  assert.equal(databaseBytes.includes(Buffer.from(token.refresh_token)), false);

  const second = await startGatewayServer({ ...options, stateStore: new GatewayStateStore(databasePath) });
  try {
    const status = await fetch(`${second.baseUrl}/v1/auth/status`, { headers: { authorization: `Bearer ${token.access_token}` } });
    assert.equal(status.status, 200);
    assert.equal((await status.json() as { account: { id: string } }).account.id, 'acct-persist');
  } finally {
    await second.close();
  }
});

test('Device 审批页要求服务端密钥，错误密钥不能签发 Token', async (context) => {
  const gateway = await startGatewayServer({
    port: 0,
    devicePollingIntervalSeconds: 0,
    deviceApprovalSecret: 'approval-secret',
    models: [model],
    upstreams: { [model.id]: { baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'secret', protocol: 'chat_completions' } },
  });
  context.after(() => gateway.close());
  const device = await createDevice(gateway.baseUrl);
  // 审批页由服务端共享密钥保护：携带错误密钥的审批必须返回 403，且不得推进设备流签发任何 Token。
  const denied = await fetch(`${gateway.baseUrl}/device/approve`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ user_code: device.user_code, approval_secret: 'wrong' }),
  });
  assert.equal(denied.status, 403);
  const pending = await pollToken(gateway.baseUrl, device.device_code);
  assert.equal(pending.status, 400);
  const approved = await fetch(`${gateway.baseUrl}/device/approve`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ user_code: device.user_code, approval_secret: 'approval-secret' }),
  });
  assert.equal(approved.status, 200);
  assert.equal((await pollToken(gateway.baseUrl, device.device_code)).status, 200);
});

test('Entitlement、Quota 和请求体上限在访问上游前失败关闭', async (context) => {
  let upstreamCalls = 0;
  const upstream = createServer((_request, response) => { upstreamCalls += 1; response.end('{}'); });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const address = upstream.address();
  assert.ok(address && typeof address !== 'string');
  const gateway = await startGatewayServer({
    port: 0,
    requestBodyLimitBytes: 128,
    monthlyRequestQuota: 0,
    entitlements: { 'acct-limited': [model.id] },
    models: [model],
    upstreams: { [model.id]: { baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: 'secret', protocol: 'chat_completions' } },
  });
  context.after(async () => { await gateway.close(); upstream.close(); await once(upstream, 'close'); });
  const token = await issueToken(gateway, 'acct-limited');
  const quota = await fetch(`${gateway.baseUrl}/v1/chat/completions`, {
    method: 'POST', headers: { authorization: `Bearer ${token.access_token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: model.id, messages: [] }),
  });
  assert.equal(quota.status, 429);
  assert.equal((await quota.json() as { error: { code: string } }).error.code, 'quota_exceeded');
  const oversized = await fetch(`${gateway.baseUrl}/v1/chat/completions`, {
    method: 'POST', headers: { authorization: `Bearer ${token.access_token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: model.id, messages: [{ role: 'user', content: 'x'.repeat(512) }] }),
  });
  assert.equal(oversized.status, 413);
  // 配额与请求体上限在访问上游前失败关闭：断言上游调用数为 0，保证被拦截的请求不消耗上游额度、不计费。
  assert.equal(upstreamCalls, 0);
});

test('OAuth slow_down 持久增加轮询间隔', async (context) => {
  const current = Date.parse('2026-08-26T00:00:00Z');
  const gateway = await startGatewayServer({
    port: 0,
    devicePollingIntervalSeconds: 5,
    now: () => new Date(current),
    models: [model],
    upstreams: {
      [model.id]: {
        baseUrl: 'http://127.0.0.1:9/v1',
        apiKey: 'secret',
        protocol: 'chat_completions',
      },
    },
  });
  context.after(() => gateway.close());
  const device = await createDevice(gateway.baseUrl);

  assert.equal((await pollToken(gateway.baseUrl, device.device_code)).status, 400);
  // 用固定 now 时钟驱动轮询而非真实 sleep：验证 OAuth Device Flow 的 slow_down 使建议轮询间隔单调累加（5→10→15）。
  const firstSlowDown = await pollToken(gateway.baseUrl, device.device_code);
  const secondSlowDown = await pollToken(gateway.baseUrl, device.device_code);
  assert.equal((await firstSlowDown.json() as { interval: number }).interval, 10);
  assert.equal((await secondSlowDown.json() as { interval: number }).interval, 15);
});

test('月度额度按 UTC 月份隔离', async (context) => {
  let current = Date.parse('2026-08-31T23:59:00Z');
  let upstreamCalls = 0;
  const upstream = createServer((_request, response) => {
    upstreamCalls += 1;
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const address = upstream.address();
  assert.ok(address && typeof address !== 'string');
  const gateway = await startGatewayServer({
    port: 0,
    now: () => new Date(current),
    accessTokenTtlSeconds: 90 * 24 * 60 * 60,
    monthlyRequestQuota: 1,
    models: [model],
    upstreams: {
      [model.id]: {
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        apiKey: 'secret',
        protocol: 'chat_completions',
      },
    },
  });
  context.after(async () => { await gateway.close(); upstream.close(); await once(upstream, 'close'); });
  const token = await issueToken(gateway);

  assert.equal((await requestInference(gateway.baseUrl, token.access_token)).status, 200);
  assert.equal((await requestInference(gateway.baseUrl, token.access_token)).status, 429);
  // 时钟从 8 月末推进到 9 月初：额度桶按 UTC 月份切分即重置；
  // upstreamCalls === 2 证实 8 月的超额请求被拦截、未到达上游。
  current = Date.parse('2026-09-01T00:01:00Z');
  assert.equal((await requestInference(gateway.baseUrl, token.access_token)).status, 200);
  assert.equal(upstreamCalls, 2);
  const usage = await fetch(`${gateway.baseUrl}/v1/usage`, {
    headers: { authorization: `Bearer ${token.access_token}` },
  }).then((response) => response.json()) as { period: string; requests: number };
  assert.equal(usage.period, '2026-09');
  assert.equal(usage.requests, 1);
});

test('上游限流、响应大小和超时返回稳定代理错误', async (context) => {
  const upstream = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const scenario = (JSON.parse(Buffer.concat(chunks).toString('utf8')) as { scenario?: string }).scenario;
      if (scenario === 'rate_limit') {
        response.writeHead(429, { 'content-type': 'application/json', 'retry-after': '9' });
        response.end('{}');
      } else if (scenario === 'large') {
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ output: 'x'.repeat(512) }));
      }
    })();
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const address = upstream.address();
  assert.ok(address && typeof address !== 'string');
  const gateway = await startGatewayServer({
    port: 0,
    maxUpstreamDurationMs: 25,
    maxUpstreamResponseBytes: 128,
    models: [model],
    upstreams: {
      [model.id]: {
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        apiKey: 'secret',
        protocol: 'chat_completions',
      },
    },
  });
  context.after(async () => { await gateway.close(); upstream.close(); await once(upstream, 'close'); });
  const token = await issueToken(gateway);

  const limited = await requestInference(gateway.baseUrl, token.access_token, 'rate_limit');
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get('retry-after'), '9');
  assert.equal((await limited.json() as { error: { retryable: boolean } }).error.retryable, true);

  const large = await requestInference(gateway.baseUrl, token.access_token, 'large');
  assert.equal(large.status, 502);
  assert.equal((await large.json() as { error: { code: string } }).error.code, 'upstream_response_too_large');

  // timeout 场景没有上游响应分支，依赖真实时钟触发 25ms 的 maxUpstreamDurationMs 上限；
  // 三个场景共同固定错误码映射：429 可重试 / 502 响应超限 / 503 超时。
  const timeout = await requestInference(gateway.baseUrl, token.access_token, 'timeout');
  assert.equal(timeout.status, 503);
  assert.equal((await timeout.json() as { error: { code: string } }).error.code, 'upstream_timeout');
});

test('Chat 与 Responses Codec 穿过真实 Gateway 后保持工具调用和 Usage', async (context) => {
  const upstream = createServer((request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.url === '/v1/chat/completions') {
      response.end(JSON.stringify({ id: 'chat-codec', choices: [{ finish_reason: 'tool_calls', message: { content: null, tool_calls: [{ id: 'call-chat', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.ts"}' } }] } }], usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 } }));
    } else {
      response.end(JSON.stringify({ id: 'response-codec', status: 'completed', output: [{ type: 'function_call', call_id: 'call-response', name: 'read_file', arguments: '{"path":"b.ts"}' }], usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 } }));
    }
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const address = upstream.address();
  assert.ok(address && typeof address !== 'string');
  const dualModel: GatewayModel = { ...model, protocols: ['chat_completions', 'responses'] };
  const gateway = await startGatewayServer({
    port: 0,
    models: [dualModel],
    upstreams: {
      [`${model.id}:chat_completions`]: { baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: 'secret', protocol: 'chat_completions' },
      [`${model.id}:responses`]: { baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: 'secret', protocol: 'responses' },
    },
  });
  context.after(async () => { await gateway.close(); upstream.close(); await once(upstream, 'close'); });
  const token = await issueToken(gateway);
  for (const [protocol, path, total] of [['chat_completions', 'a.ts', 6], ['responses', 'b.ts', 8]] as const) {
    const provider = new OpenAICompatibleProvider({ model: model.id, baseUrl: `${gateway.baseUrl}/v1`, apiKey: token.access_token, protocol });
    const result = await provider.complete({ items: [textMessage(`user-${protocol}`, 'user', 'read')] });
    const call = result.output.find((item) => item.type === 'tool_call');
    assert.ok(call?.type === 'tool_call');
    assert.deepEqual(call.arguments, { path });
    assert.equal(result.usage?.totalTokens, total);
  }
});

async function createDevice(baseUrl: string): Promise<{ device_code: string; user_code: string }> {
  return fetch(`${baseUrl}/oauth/device/authorization`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'client_id=echolens-cli',
  }).then((response) => response.json()) as Promise<{ device_code: string; user_code: string }>;
}

function pollToken(baseUrl: string, deviceCode: string): Promise<Response> {
  return fetch(`${baseUrl}/oauth/token`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: deviceCode, client_id: 'echolens-cli' }),
  });
}

async function issueToken(gateway: GatewayServerHandle, accountId = 'acct-test'): Promise<{ access_token: string; refresh_token: string }> {
  const device = await createDevice(gateway.baseUrl);
  assert.equal(gateway.approveDeviceCode(device.device_code, accountId), true);
  const response = await pollToken(gateway.baseUrl, device.device_code);
  assert.equal(response.status, 200);
  return response.json() as Promise<{ access_token: string; refresh_token: string }>;
}

function requestInference(baseUrl: string, accessToken: string, scenario = 'ok'): Promise<Response> {
  return fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: model.id, messages: [], scenario }),
  });
}
