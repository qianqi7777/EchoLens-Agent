import { readFile, realpath, stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadGithubIssues } from './github.js';
import { assertInside, runComparison } from './engine.js';
import { runLabProcess } from './process.js';
import { validateIssueSet } from './validation.js';
import { redactText } from '../../src/providers/redaction.js';
import type { ProviderConfig } from './types.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export interface QualityResult { passed: boolean; durationMs: number; output: string; timedOut?: boolean; cancelled?: boolean; truncated?: boolean }
interface LabOptions {
  repoRoot?: string;
  externalEnabled?: boolean;
  compare?: typeof runComparison;
  github?: typeof loadGithubIssues;
  quality?: (signal: AbortSignal) => Promise<QualityResult>;
}

/** Importing this module does not listen or execute commands; tests inject local substitutes. */
export function createLabServer(options: LabOptions = {}) {
  const configuredRoot = path.resolve(options.repoRoot ?? process.env.AGENT_TEST_REPO_ROOT ?? path.resolve(root, '..'));
  const externalEnabled = options.externalEnabled ?? process.env.AGENT_TEST_ENABLE_EXTERNAL === 'true';
  let active: { kind: string; startedAt: string } | undefined;
  const server = createServer(async (request, response) => {
    const controller = new AbortController();
    const disconnect = () => { if (!response.writableEnded) controller.abort('browser_disconnected'); };
    response.on('close', disconnect);
    setHeaders(response);
    try {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      const allowedHosts = [`127.0.0.1:${port}`, `localhost:${port}`];
      if (!allowedHosts.includes(request.headers.host ?? '')) throw new HttpError(403, '拒绝未知 Host');
      const origin = `http://${request.headers.host}`;
      if (request.headers.origin && request.headers.origin !== origin) throw new HttpError(403, '拒绝跨来源请求');
      if (request.headers['sec-fetch-site'] === 'cross-site') throw new HttpError(403, '拒绝跨站请求');
      const url = new URL(request.url ?? '/', origin);
      if (request.method === 'GET' && url.pathname === '/api/health') {
        return json(response, { ok: true, port, externalEnabled, active: active ?? null });
      }
      if (request.method === 'GET' && url.pathname === '/api/github/issues') {
        return json(response, await (options.github ?? loadGithubIssues)(url.searchParams.get('repo') ?? '',
          Number(url.searchParams.get('limit') ?? 20), controller.signal));
      }
      if (request.method === 'POST' && ['/api/compare', '/api/quality'].includes(url.pathname)) {
        if (request.headers['x-agent-test-request'] !== '1') throw new HttpError(403, '缺少本地工作台请求标记');
        if (!request.headers['content-type']?.startsWith('application/json')) throw new HttpError(415, '只接受 application/json');
        const body: unknown = JSON.parse(await readBody(request));
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, '请求必须是 JSON 对象');
        if (active) throw new HttpError(409, '已有任务运行中，请等待完成或取消');
        active = { kind: url.pathname === '/api/compare' ? 'compare' : 'quality', startedAt: new Date().toISOString() };
        try {
          if (url.pathname === '/api/quality') {
            return json(response, await (options.quality ?? ((signal) => runQuality(path.resolve(root, '..'), signal)))(controller.signal));
          }
          const data = body as Record<string, unknown>;
          validateIssueSet(data.issueSet);
          if (typeof data.repoRoot !== 'string' || data.repoRoot.length > 2000) throw new HttpError(400, '仓库路径无效');
          if (data.execute !== undefined && typeof data.execute !== 'boolean') throw new HttpError(400, 'execute 必须是布尔值');
          if (data.execute && (!externalEnabled || data.confirmExternal !== true)) throw new HttpError(403, '真实 CLI 执行未授权或未确认');
          const providers = resolveProviders(data.providers);
          if (!providers.some((provider) => provider.enabled)) throw new HttpError(400, '至少选择一个 Provider');
          const base = await realpath(configuredRoot);
          const workspace = await realpath(path.resolve(base, data.repoRoot || '.'));
          assertInside(base, workspace);
          if (!(await stat(workspace)).isDirectory()) throw new HttpError(400, '仓库路径不是目录');
          return json(response, await (options.compare ?? runComparison)(data.issueSet, providers, workspace, data.execute === true, controller.signal));
        } finally { active = undefined; }
      }
      if (url.pathname.startsWith('/api/')) throw new HttpError(request.method === 'GET' ? 404 : 405, '接口或请求方法不存在');
      if (request.method !== 'GET') throw new HttpError(405, '只支持 GET');
      await staticFile(response, url.pathname);
    } catch (error) {
      json(response, { error: redactText(error instanceof Error ? error.message : '请求失败') }, error instanceof HttpError ? error.status : 400);
    } finally { response.off('close', disconnect); }
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 10000;
  return server;
}

class HttpError extends Error { constructor(readonly status: number, message: string) { super(message); } }

async function staticFile(response: ServerResponse, pathname: string): Promise<void> {
  const assets: Record<string, [string, string]> = {
    '/': [path.join(root, 'web/index.html'), 'text/html'],
    '/index.html': [path.join(root, 'web/index.html'), 'text/html'],
    '/app.js': [path.join(root, 'web/app.js'), 'text/javascript'],
    '/styles.css': [path.join(root, 'web/styles.css'), 'text/css'],
    '/icons.js': [path.resolve(root, '../node_modules/lucide/dist/umd/lucide.js'), 'text/javascript'],
    '/example.json': [path.join(root, 'fixtures/issues.example.json'), 'application/json'],
  };
  const asset = assets[pathname];
  if (!asset) throw new HttpError(404, '资源不存在');
  response.setHeader('content-type', `${asset[1]}; charset=utf-8`);
  response.end(await readFile(asset[0]));
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    request.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 2_000_000) { chunks.length = 0; reject(new HttpError(413, '请求体超过 2 MB')); return; }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
    request.on('aborted', () => reject(new HttpError(400, '请求已中断')));
  });
}

function json(response: ServerResponse, value: unknown, status = 200): void {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(value));
}

function setHeaders(response: ServerResponse) {
  response.setHeader('cache-control', 'no-store');
  response.setHeader('x-content-type-options', 'nosniff');
  response.setHeader('content-security-policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
  response.setHeader('referrer-policy', 'no-referrer');
}

function resolveProviders(requested: unknown): ProviderConfig[] {
  const known: Record<ProviderConfig['id'], ProviderConfig> = {
    echolens: { id: 'echolens', label: 'EchoLens Agent', command: process.execPath,
      args: ['--import', import.meta.resolve('tsx'), path.join(root, 'src/echolens-runner.ts'), '{prompt}'] },
    'local-sim': { id: 'local-sim', label: '本地模拟' },
    codex: { id: 'codex', label: 'Codex CLI', command: 'codex', args: ['exec', '--ephemeral', '--sandbox', 'workspace-write', '--json', '{prompt}'] },
    claude: { id: 'claude', label: 'Claude Code', command: 'claude', args: ['-p', '{prompt}'] },
    cloudecode: { id: 'cloudecode', label: 'Cloudecode', command: 'cloudecode', args: ['{prompt}'] },
  };
  if (!Array.isArray(requested) || !requested.length || requested.length > 5) throw new HttpError(400, 'Provider 列表无效');
  const seen = new Set<string>();
  return requested.map((item: unknown) => {
    if (!item || typeof item !== 'object') throw new HttpError(400, 'Provider 格式无效');
    const { id, enabled } = item as Record<string, unknown>;
    if (typeof id !== 'string' || !Object.hasOwn(known, id) || typeof enabled !== 'boolean' || seen.has(id)) throw new HttpError(400, 'Provider ID 重复、未知或 enabled 格式无效');
    seen.add(id);
    return { ...known[id as ProviderConfig['id']], enabled };
  });
}

async function runQuality(repoRoot: string, signal: AbortSignal): Promise<QualityResult> {
  const started = Date.now();
  const command = process.platform === 'win32' ? (process.env.ComSpec ?? 'cmd.exe') : 'npm';
  const args = process.platform === 'win32' ? ['/d', '/s', '/c', 'npm.cmd run check:ci'] : ['run', 'check:ci'];
  const result = await runLabProcess(command, args, repoRoot, 10 * 60_000, signal);
  return { passed: result.exitCode === 0 && !result.timedOut && !result.cancelled,
    durationMs: Date.now() - started, output: `${result.stdout}${result.stderr}`,
    timedOut: result.timedOut, cancelled: result.cancelled, truncated: result.truncated };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.AGENT_TEST_PORT ?? 4317);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('AGENT_TEST_PORT 必须是 1-65535');
  const server = createLabServer();
  server.on('error', (error) => { console.error(`测试服务启动失败：${error.message}`); process.exitCode = 1; });
  server.listen(port, '127.0.0.1', () => process.stdout.write(`Agent Test Lab: http://127.0.0.1:${port}\n`));
}
