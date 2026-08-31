import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadEnvFile } from 'node:process';
import { test } from 'node:test';
import { ensureStartupConfiguration, type SetupTerminal } from './startup-config.js';

class ScriptedTerminal implements SetupTerminal {
  constructor(private readonly answers: string[]) {}

  async question(): Promise<string> {
    // 按固定队列顺序消费预设回答；输入耗尽时立即抛错让场景失败，而不是让向导挂起。
    const answer = this.answers.shift();
    if (answer === undefined) throw new Error('测试输入不足');
    return answer;
  }
}

test('首次启动默认生成 DeepSeek Chat Completions 配置', async () => {
  // 直连模式把明文 API Key 写入本地 .env.local，同时断言不混入任何网关
  // 凭据字段；一并覆盖默认 DeepSeek 预设与默认 Chat Completions 协议。
  const env: NodeJS.ProcessEnv = {};
  let written = '';
  const result = await ensureStartupConfiguration({
    terminal: new ScriptedTerminal(['', '', 'sk-local-test']),
    env,
    projectRoot: 'D:\\EchoLens-Agent',
    notify: () => undefined,
    write: async (_path, content) => {
      written = content;
    },
  });

  assert.equal(result.route, 'direct');
  assert.equal(env.AGENT_DIRECT_BASE_URL, 'https://api.deepseek.com/v1');
  assert.equal(env.AGENT_DIRECT_MODEL, 'deepseek-chat');
  assert.equal(env.AGENT_DIRECT_PROTOCOL, 'chat_completions');
  assert.match(written, /AGENT_DIRECT_API_KEY="sk-local-test"/u);
  assert.doesNotMatch(written, /AGENT_GATEWAY_ACCESS_TOKEN/u);
});

test('云端向导只生成 Gateway 凭据引用', async () => {
  // 网关模式首次配置不得收集、落盘或透传任何 Token：断言只产生凭据引用
  // gateway-token:default，文件里既无网关 Access Token 也无直连 API Key。
  const env: NodeJS.ProcessEnv = {};
  let written = '';
  const result = await ensureStartupConfiguration({
    terminal: new ScriptedTerminal([
      '2',
      'y',
      'https://gateway.example.com',
      '',
    ]),
    env,
    projectRoot: 'D:\\EchoLens-Agent',
    notify: () => undefined,
    write: async (_path, content) => {
      written = content;
    },
  });

  assert.equal(result.route, 'gateway');
  assert.equal(env.AGENT_GATEWAY_MODEL, 'deepseek-chat');
  assert.equal(env.AGENT_GATEWAY_CREDENTIAL_REF, 'gateway-token:default');
  assert.equal(env.AGENT_GATEWAY_PRIVACY, 'metadata');
  assert.equal(env.AGENT_GATEWAY_PRIVACY_CONFIRMED, 'true');
  assert.doesNotMatch(written, /^AGENT_GATEWAY_ACCESS_TOKEN=/mu);
  assert.doesNotMatch(written, /AGENT_DIRECT_API_KEY/u);
});

test('生成的 .env.local 可以由 Node 原生加载', async (context) => {
  // 用含 # 和 = 的值验证 quoteEnv 的 JSON 引号在 Node 原生 loadEnvFile 下
  // 无损往返；这里故意使用真实 process.env，依赖 after 钩子清理。
  const projectRoot = await mkdtemp(join(tmpdir(), 'echolens-startup-'));
  context.after(async () => {
    delete process.env.AGENT_DIRECT_API_KEY;
    await rm(projectRoot, { recursive: true, force: true });
  });

  const result = await ensureStartupConfiguration({
    terminal: new ScriptedTerminal(['', '', 'sk-value-with-#-and-=']),
    env: {},
    projectRoot,
    notify: () => undefined,
  });
  loadEnvFile(result.configPath);

  assert.equal(process.env.AGENT_DIRECT_API_KEY, 'sk-value-with-#-and-=');
});
