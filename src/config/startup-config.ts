import { chmod, mkdir, rename, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { loadEnvFile } from 'node:process';

export interface SetupTerminal {
  question(prompt: string): Promise<string>;
}

export interface StartupConfigurationOptions {
  terminal: SetupTerminal;
  env?: NodeJS.ProcessEnv;
  projectRoot?: string;
  force?: boolean;
  write?: (path: string, content: string) => Promise<void>;
  notify?: (message: string) => void;
}

export interface StartupConfigurationResult {
  configured: boolean;
  configPath: string;
  route: 'direct' | 'gateway';
}

export async function ensureStartupConfiguration(
  options: StartupConfigurationOptions,
): Promise<StartupConfigurationResult> {
  const env = options.env ?? process.env;
  const configPath = resolve(options.projectRoot ?? process.cwd(), '.env.local');

  if (!options.force && existsSync(configPath)) {
    loadLocalEnv(configPath, env);
  }

  const currentRoute = routeValue(env.AGENT_MODEL_ROUTE);
  if (!options.force && currentRoute) {
    return { configured: false, configPath, route: currentRoute };
  }

  const notify = options.notify ?? console.log;
  notify('');
  notify('EchoLens Agent 首次启动设置');
  notify('配置只保存在本机 .env.local；该文件已被 Git 忽略。');

  const routeChoice = await askChoice(
    options.terminal,
    '模型来源 [1=自定义 API（推荐）/ 2=EchoLens 云端]',
    ['1', '2'],
    '1',
  );
  const values =
    routeChoice === '1'
      ? await directConfiguration(options.terminal, env, notify)
      : await gatewayConfiguration(options.terminal, env, notify);

  const content = renderEnv(values);
  const write = options.write ?? writePrivateEnvFile;
  await write(configPath, content);
  Object.assign(env, values);

  notify(`配置已保存：${configPath}`);
  notify(`当前路由：${values.AGENT_MODEL_ROUTE}`);
  return {
    configured: true,
    configPath,
    route: values.AGENT_MODEL_ROUTE as 'direct' | 'gateway',
  };
}

function loadLocalEnv(path: string, env: NodeJS.ProcessEnv): void {
  if (env !== process.env) return;
  try {
    loadEnvFile(path);
  } catch (error) {
    throw new Error(
      `无法加载本地配置 ${path}：${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function directConfiguration(
  terminal: SetupTerminal,
  env: NodeJS.ProcessEnv,
  notify: (message: string) => void,
): Promise<Record<string, string>> {
  const preset = await askChoice(
    terminal,
    'API 预设 [1=DeepSeek / 2=其他 OpenAI-compatible API]',
    ['1', '2'],
    '1',
  );

  let baseUrl = 'https://api.deepseek.com/v1';
  let model = 'deepseek-chat';
  let protocol = 'chat_completions';
  if (preset === '2') {
    baseUrl = await askRequired(terminal, '响应地址（Base URL）');
    model = await askRequired(terminal, '模型名称');
    const protocolChoice = await askChoice(
      terminal,
      '接口协议 [1=Chat Completions / 2=Responses]',
      ['1', '2'],
      '1',
    );
    protocol = protocolChoice === '1' ? 'chat_completions' : 'responses';
  } else {
    notify(`默认响应地址：${baseUrl}`);
    notify(`默认模型：${model} | 协议：Chat Completions`);
  }

  const apiKey = await askRequired(
    terminal,
    'API Key（仅写入本机 .env.local，输入内容当前会显示）',
    env.AGENT_DIRECT_API_KEY,
  );
  return {
    AGENT_MODEL_ROUTE: 'direct',
    AGENT_DIRECT_MODEL: model,
    AGENT_DIRECT_BASE_URL: baseUrl,
    AGENT_DIRECT_PROTOCOL: protocol,
    AGENT_DIRECT_CREDENTIAL_REF: 'env:AGENT_DIRECT_API_KEY',
    AGENT_DIRECT_PRIVACY: 'full-context',
    AGENT_DIRECT_STREAMING: 'true',
    AGENT_DIRECT_API_KEY: apiKey,
    AGENT_WORKSPACE_ROOT: env.AGENT_WORKSPACE_ROOT?.trim() || process.cwd(),
  };
}

async function gatewayConfiguration(
  terminal: SetupTerminal,
  env: NodeJS.ProcessEnv,
  notify: (message: string) => void,
): Promise<Record<string, string>> {
  notify('云端模式会把模型上下文发送到你配置的 EchoLens Gateway。');
  notify('Gateway 只代理模型请求，不获得本机工具和工作区执行权限。');
  const confirmed = await askChoice(terminal, '确认继续 [y/n]', ['y', 'n'], 'n');
  if (confirmed !== 'y') {
    notify('已改用自定义 API 设置。');
    return directConfiguration(terminal, env, notify);
  }

  const gatewayUrl = await askRequired(
    terminal,
    'Gateway 地址',
    env.AGENT_GATEWAY_URL ?? env.AGENT_DEFAULT_GATEWAY_URL,
  );
  const model = await askRequired(terminal, '云端模型', env.AGENT_GATEWAY_MODEL ?? 'deepseek-chat');
  const accessToken = await askRequired(
    terminal,
    'Gateway Access Token（仅写入本机 .env.local，输入内容当前会显示）',
    env.AGENT_GATEWAY_ACCESS_TOKEN,
  );
  return {
    AGENT_MODEL_ROUTE: 'gateway',
    AGENT_GATEWAY_URL: gatewayUrl,
    AGENT_GATEWAY_MODEL: model,
    AGENT_GATEWAY_CREDENTIAL_REF: 'env:AGENT_GATEWAY_ACCESS_TOKEN',
    AGENT_GATEWAY_PRIVACY: 'full-context',
    AGENT_GATEWAY_ACCESS_TOKEN: accessToken,
    AGENT_WORKSPACE_ROOT: env.AGENT_WORKSPACE_ROOT?.trim() || process.cwd(),
  };
}

async function askChoice(
  terminal: SetupTerminal,
  label: string,
  allowed: readonly string[],
  defaultValue: string,
): Promise<string> {
  while (true) {
    const value = (await terminal.question(`${label}（默认 ${defaultValue}）：`)).trim() || defaultValue;
    if (allowed.includes(value.toLowerCase())) return value.toLowerCase();
    console.error(`请输入：${allowed.join(' / ')}`);
  }
}

async function askRequired(
  terminal: SetupTerminal,
  label: string,
  defaultValue?: string,
): Promise<string> {
  while (true) {
    const suffix = defaultValue ? `（默认 ${defaultValue}）` : '';
    const value = (await terminal.question(`${label}${suffix}：`)).trim() || defaultValue?.trim();
    if (value && !/[\r\n]/u.test(value)) return value;
    console.error(`${label}不能为空。`);
  }
}

function renderEnv(values: Record<string, string>): string {
  return [
    '# EchoLens Agent 本地配置。包含凭据，不得提交到 Git。',
    ...Object.entries(values).map(([key, value]) => `${key}=${quoteEnv(value)}`),
    '',
  ].join('\n');
}

function quoteEnv(value: string): string {
  if (/[\r\n]/u.test(value)) throw new Error('环境变量值不能包含换行符');
  return JSON.stringify(value);
}

async function writePrivateEnvFile(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.tmp`;
  await writeFile(temporaryPath, content, { encoding: 'utf8', mode: 0o600 });
  await rename(temporaryPath, path);
  if (process.platform !== 'win32') await chmod(path, 0o600);
}

function routeValue(value: string | undefined): 'direct' | 'gateway' | undefined {
  return value === 'direct' || value === 'gateway' ? value : undefined;
}
