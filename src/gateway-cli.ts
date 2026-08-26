import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import { resolve } from 'node:path';
import { createDefaultGatewayTokenStore, GatewayClient } from './runtime/index.js';

const command = process.argv[2] ?? 'status';
const store = option('--token-file')
  ? new (await import('./credentials/gateway-token-store.js')).JsonGatewayTokenStore(option('--token-file'))
  : createDefaultGatewayTokenStore();

if (existsSync(resolve(process.cwd(), '.env.local'))) loadEnvFile(resolve(process.cwd(), '.env.local'));
const gatewayUrl = option('--url') ?? process.env.AGENT_GATEWAY_URL;

try {
  if (!gatewayUrl) throw new Error('缺少 Gateway 地址，请使用 --url 或配置 AGENT_GATEWAY_URL');
  if (command === 'login') await login(gatewayUrl);
  else if (command === 'refresh') await refresh(gatewayUrl);
  else if (command === 'logout') await logout(gatewayUrl);
  else if (command === 'status') await status(gatewayUrl);
  else throw new Error(`未知 Gateway 命令：${command}`);
} catch (error) {
  console.error(`Gateway 操作失败：${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}

async function login(url: string): Promise<void> {
  await confirmRemoteContext();
  const client = new GatewayClient({ gatewayUrl: url, accessToken: '' });
  const device = await client.createDeviceAuthorization();
  console.log(`请在浏览器打开：${device.verificationUri}`);
  console.log(`设备验证码：${device.userCode}`);
  if (device.verificationUriComplete) console.log(`完整验证地址：${device.verificationUriComplete}`);
  const deadline = Date.now() + device.expiresIn * 1000;
  let interval = device.interval;
  while (Date.now() < deadline) {
    await sleep(interval * 1000);
    const result = await client.pollDeviceToken(device.deviceCode);
    if ('pending' in result) {
      interval = result.interval;
      continue;
    }
    await store.save({
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
      expiresAt: new Date(Date.now() + result.expiresIn * 1000).toISOString(),
      scope: result.scope,
    });
    await updateGatewayEnv(url);
    console.log('Gateway 登录成功，令牌已保存到本机私有目录。');
    return;
  }
  throw new Error('Device Code 已过期，请重新执行 login');
}

async function refresh(url: string): Promise<void> {
  const current = await store.load();
  if (!current?.refreshToken) throw new Error('本机没有可用 Refresh Token，请先执行 login');
  const client = new GatewayClient({ gatewayUrl: url, accessToken: current.accessToken });
  const result = await client.refreshToken(current.refreshToken);
  await store.save({
    accessToken: result.accessToken,
    refreshToken: result.refreshToken,
    expiresAt: new Date(Date.now() + result.expiresIn * 1000).toISOString(),
    scope: result.scope,
  });
  await updateGatewayEnv(url);
  console.log('Gateway Token 已刷新并轮换。');
}

async function logout(url: string): Promise<void> {
  const current = await store.load();
  let remoteError: unknown;
  try {
    if (current) {
      const client = new GatewayClient({ gatewayUrl: url, accessToken: current.accessToken });
      await client.revokeToken(current.accessToken);
      if (current.refreshToken) await client.revokeToken(current.refreshToken);
    }
  } catch (error) {
    remoteError = error;
  } finally {
    await store.clear();
  }
  if (remoteError) throw new Error('本地令牌已清理，但远端会话撤销失败', { cause: remoteError });
  console.log('Gateway 会话已注销，本地令牌已清理。');
}

async function status(url: string): Promise<void> {
  const current = await store.load();
  if (!current) {
    console.log('Gateway 尚未登录。');
    return;
  }
  const client = new GatewayClient({ gatewayUrl: url, accessToken: current.accessToken });
  const auth = await client.authStatus();
  console.log(`Gateway 状态：${auth.status}`);
  if (auth.account?.displayName) console.log(`账号：${auth.account.displayName}`);
  if (auth.expiresAt) console.log(`Access Token 到期：${auth.expiresAt}`);
}

async function updateGatewayEnv(url: string): Promise<void> {
  const { readFile, rename, writeFile } = await import('node:fs/promises');
  const path = resolve(process.cwd(), '.env.local');
  const existing = existsSync(path) ? await readFile(path, 'utf8') : '';
  const rendered = updateEnv(existing, {
    AGENT_MODEL_ROUTE: 'gateway',
    AGENT_GATEWAY_URL: url,
    AGENT_GATEWAY_MODEL: option('--model') ?? process.env.AGENT_GATEWAY_MODEL ?? 'deepseek-chat',
    AGENT_GATEWAY_CREDENTIAL_REF: 'gateway-token:default',
    AGENT_GATEWAY_PRIVACY: process.env.AGENT_GATEWAY_PRIVACY ?? 'metadata',
    AGENT_GATEWAY_PRIVACY_CONFIRMED: 'true',
  }, new Set(['AGENT_GATEWAY_ACCESS_TOKEN']));
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, rendered, { encoding: 'utf8', mode: 0o600 });
  await rename(temporary, path);
}

async function confirmRemoteContext(): Promise<void> {
  if (process.env.AGENT_GATEWAY_PRIVACY_CONFIRMED === 'true' || process.argv.includes('--confirm-remote')) return;
  const readline = await import('node:readline/promises');
  const terminal = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log('Gateway 路由会把所选模型上下文发送到远程服务；本地工具仍只在本机执行。');
    const answer = (await terminal.question('确认继续 [y/N]：')).trim().toLowerCase();
    if (answer !== 'y') throw new Error('未确认远程上下文传输');
  } finally {
    terminal.close();
  }
}

function updateEnv(existing: string, updates: Record<string, string>, deleted: ReadonlySet<string>): string {
  const lines = existing.split(/\r?\n/u);
  const written = new Set<string>();
  const output = lines.flatMap((line) => {
    const match = /^([A-Z][A-Z0-9_]*)=/u.exec(line);
    if (!match) return [line];
    const key = match[1]!;
    if (deleted.has(key)) return [];
    if (!(key in updates)) return [line];
    written.add(key);
    return [`${key}=${JSON.stringify(updates[key])}`];
  });
  for (const [key, value] of Object.entries(updates)) {
    if (!written.has(key)) output.push(`${key}=${JSON.stringify(value)}`);
  }
  while (output.at(-1) === '') output.pop();
  return `${output.join('\n')}\n`;
}

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
