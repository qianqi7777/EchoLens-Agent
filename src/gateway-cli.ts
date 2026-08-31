// Gateway 凭据命令行入口。令牌只在本机私有存储与远端 OAuth 端点之间流转：任何子命令
// 都不把令牌打印到终端，`.env.local` 只写入路由配置与凭据引用，不写入令牌本体。
import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import { resolve } from 'node:path';
import { createDefaultGatewayTokenStore, GatewayClient } from './runtime/index.js';

const command = process.argv[2] ?? 'status';
// --token-file 只面向测试与隔离环境（纯 JSON 存储）；默认走系统保护的私有目录，
// Windows 下由 DPAPI 加密，其它平台退化为仅当前用户可读的文件。
const store = option('--token-file')
  ? new (await import('./credentials/gateway-token-store.js')).JsonGatewayTokenStore(option('--token-file'))
  : createDefaultGatewayTokenStore();

// 缺失 .env.local 是正常状态（令牌不在该文件里），因此只在存在时加载，不报错。
if (existsSync(resolve(process.cwd(), '.env.local'))) loadEnvFile(resolve(process.cwd(), '.env.local'));
const gatewayUrl = option('--url') ?? process.env.AGENT_GATEWAY_URL;

try {
  // 顶层只回显 message：错误对象可能携带端点 URL 与请求细节，完整堆栈不输出到终端。
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

/**
 * 执行 OAuth Device Flow 登录并把令牌写入本机私有存储。
 *
 * 轮询节奏完全由服务端下发：Device Flow 允许服务端在响应里下调间隔表达 `slow_down`，
 * 客户端沿用旧间隔会被限流。轮询总时长也以服务端 `expiresIn` 为上限，不自行延长。
 * @param url Gateway 地址，来自 `--url` 或 `AGENT_GATEWAY_URL`。
 * @throws 设备码过期或用户未确认远程上下文传输时抛出。
 */
async function login(url: string): Promise<void> {
  await confirmRemoteContext();
  // 设备授权阶段还没有凭据，这里传空串而不是占位符，避免把无意义的字符写进 Authorization 头。
  const client = new GatewayClient({ gatewayUrl: url, accessToken: '' });
  const device = await client.createDeviceAuthorization();
  // 只回显供用户肉眼操作的字段；deviceCode 本身可用于换取令牌，不输出。
  console.log(`请在浏览器打开：${device.verificationUri}`);
  console.log(`设备验证码：${device.userCode}`);
  if (device.verificationUriComplete) console.log(`完整验证地址：${device.verificationUriComplete}`);
  const deadline = Date.now() + device.expiresIn * 1000;
  let interval = device.interval;
  while (Date.now() < deadline) {
    await sleep(interval * 1000);
    const result = await client.pollDeviceToken(device.deviceCode);
    if ('pending' in result) {
      // 每次都以服务端最新 interval 继续，慢下来的要求由服务端单方面决定。
      interval = result.interval;
      continue;
    }
    // 过期时间按本地时钟换算成绝对时间保存，进程重启后才能判断是否需要刷新。
    await store.save({
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
      expiresAt: new Date(Date.now() + result.expiresIn * 1000).toISOString(),
      scope: result.scope,
    });
    // 只把路由与端点写回 .env.local，令牌本体留在私有存储，避免明文令牌落进仓库目录。
    await updateGatewayEnv(url);
    console.log('Gateway 登录成功，令牌已保存到本机私有目录。');
    return;
  }
  throw new Error('Device Code 已过期，请重新执行 login');
}

/**
 * 用 Refresh Token 轮换 Access Token。
 * @throws 本机没有 Refresh Token 时抛出，需要先执行 login。
 */
async function refresh(url: string): Promise<void> {
  const current = await store.load();
  if (!current?.refreshToken) throw new Error('本机没有可用 Refresh Token，请先执行 login');
  const client = new GatewayClient({ gatewayUrl: url, accessToken: current.accessToken });
  const result = await client.refreshToken(current.refreshToken);
  // 服务端通常会同时轮换 refresh token，必须整体覆盖保存；保留旧值会让下次刷新失败。
  await store.save({
    accessToken: result.accessToken,
    refreshToken: result.refreshToken,
    expiresAt: new Date(Date.now() + result.expiresIn * 1000).toISOString(),
    scope: result.scope,
  });
  await updateGatewayEnv(url);
  console.log('Gateway Token 已刷新并轮换。');
}

/**
 * 注销 Gateway 会话。
 *
 * 本地清理优先于远端撤销：即使联系不上 Gateway，本机令牌也必须被清掉，否则会在本机
 * 留下仍然可用的凭据。
 * @throws 远端撤销失败时抛出，此时本地令牌已经清理完毕。
 */
async function logout(url: string): Promise<void> {
  const current = await store.load();
  let remoteError: unknown;
  try {
    if (current) {
      const client = new GatewayClient({ gatewayUrl: url, accessToken: current.accessToken });
      await client.revokeToken(current.accessToken);
      // 两个令牌都要撤销：只撤销 access token 时，refresh token 仍可换来新凭据。
      if (current.refreshToken) await client.revokeToken(current.refreshToken);
    }
  } catch (error) {
    // 远端失败只记录不抛出，保证 finally 的本地清理一定执行。
    remoteError = error;
  } finally {
    await store.clear();
  }
  // 明确区分“本地已清理 + 远端失败”，避免用户误以为会话仍然在线。
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
  // 只回显状态、账号显示名与到期时间，不输出任何令牌字段。
  console.log(`Gateway 状态：${auth.status}`);
  if (auth.account?.displayName) console.log(`账号：${auth.account.displayName}`);
  if (auth.expiresAt) console.log(`Access Token 到期：${auth.expiresAt}`);
}

/**
 * 把 Gateway 路由配置写回 `.env.local`。
 *
 * 先写临时文件再 `rename`：同分区内 rename 是原子操作，进程被中断时不会留下半截配置。
 * 临时文件以 0600 创建，避免同机其他用户读到端点与凭据引用。
 */
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
    // 显式剔除历史遗留的明文令牌变量：迁移到私有存储后，旧配置里的令牌不得继续生效。
  }, new Set(['AGENT_GATEWAY_ACCESS_TOKEN']));
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, rendered, { encoding: 'utf8', mode: 0o600 });
  await rename(temporary, path);
}

/**
 * 首次登录前确认用户接受上下文出境。
 *
 * 这里确认的只是“模型上下文会发往远端”，与工具权限无关——本地工具执行仍然只发生在本机。
 * @throws 用户未确认时抛出，登录随即中止。
 */
async function confirmRemoteContext(): Promise<void> {
  // 已确认过的环境（由 updateGatewayEnv 写入标记）或显式 --confirm-remote 不再重复打扰。
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

/**
 * 就地更新 dotenv 文本，保留注释与无关行，只改写命中键。
 * @param deleted 需要从文件中整体移除的键。
 */
function updateEnv(existing: string, updates: Record<string, string>, deleted: ReadonlySet<string>): string {
  const lines = existing.split(/\r?\n/u);
  const written = new Set<string>();
  const output = lines.flatMap((line) => {
    // 只识别行首的大写下划线键，避免误改注释行或带 `export ` 前缀的行。
    const match = /^([A-Z][A-Z0-9_]*)=/u.exec(line);
    if (!match) return [line];
    const key = match[1]!;
    if (deleted.has(key)) return [];
    if (!(key in updates)) return [line];
    written.add(key);
    // 统一用 JSON 字符串形式写入，值里的空格、引号和 # 才不会被 dotenv 或 shell 解析错。
    return [`${key}=${JSON.stringify(updates[key])}`];
  });
  for (const [key, value] of Object.entries(updates)) {
    if (!written.has(key)) output.push(`${key}=${JSON.stringify(value)}`);
  }
  // 收敛尾部空行，保证文件以单个换行结尾，避免多次运行后空行累积。
  while (output.at(-1) === '') output.pop();
  return `${output.join('\n')}\n`;
}

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

// Device Flow 轮询间隔由服务端下发，这里只负责等待，不实现任何退避策略。
function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
