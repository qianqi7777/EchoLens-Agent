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
    const answer = this.answers.shift();
    if (answer === undefined) throw new Error('测试输入不足');
    return answer;
  }
}

test('首次启动默认生成 DeepSeek Chat Completions 配置', async () => {
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
