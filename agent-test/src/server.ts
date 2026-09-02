import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { loadGithubIssues } from './github.js';
import { runComparison } from './engine.js';
import type { IssueSet, ProviderConfig } from './types.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const webRoot = path.join(root, 'web');
const repoRoot = path.resolve(process.env.AGENT_TEST_REPO_ROOT ?? path.resolve(root, '..'));
const port = Number(process.env.AGENT_TEST_PORT ?? 4317);

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? '127.0.0.1'}`);
    assertSameOrigin(request, url);
    if (request.method === 'GET' && url.pathname === '/api/health') return json(response, { ok: true, port });
    if (request.method === 'GET' && url.pathname === '/api/github/issues') {
      const repo = url.searchParams.get('repo') ?? '';
      return json(response, await loadGithubIssues(repo, Number(url.searchParams.get('limit') ?? 20)));
    }
    if (request.method === 'POST' && url.pathname === '/api/compare') {
      const body = JSON.parse(await readBody(request)) as { issueSet: IssueSet; providers: Array<Pick<ProviderConfig, 'id' | 'enabled'>>; repoRoot: string; execute?: boolean };
      const workspace = resolveWorkspace(body.repoRoot || '.');
      return json(response, await runComparison(body.issueSet, resolveProviders(body.providers), workspace, body.execute === true));
    }
    if (request.method === 'POST' && url.pathname === '/api/quality') {
      return json(response, await runQuality());
    }
    return staticFile(response, url.pathname);
  } catch (error) {
    json(response, { error: error instanceof Error ? error.message : '请求失败' }, 400);
  }
});

server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`Agent Test Lab: http://127.0.0.1:${port}\n`);
});

async function staticFile(response: import('node:http').ServerResponse, pathname: string): Promise<void> {
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\//u, '');
  const target = path.resolve(webRoot, relative);
  if (!target.startsWith(`${webRoot}${path.sep}`)) return json(response, { error: '路径越界' }, 404);
  try {
    const contentType = target.endsWith('.css') ? 'text/css; charset=utf-8' : target.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/html; charset=utf-8';
    const content = await readFile(target);
    response.writeHead(200, { 'content-type': contentType });
    response.end(content);
  } catch {
    json(response, { error: '资源不存在' }, 404);
  }
}

function readBody(request: import('node:http').IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    request.on('data', (chunk) => { body += String(chunk); if (body.length > 2_000_000) reject(new Error('请求体过大')); });
    request.on('end', () => resolve(body));
    request.on('error', reject);
  });
}

function json(response: import('node:http').ServerResponse, value: unknown, status = 200): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(value));
}

function resolveProviders(requested: Array<Pick<ProviderConfig, 'id' | 'enabled'>>): ProviderConfig[] {
  const known: Record<ProviderConfig['id'], ProviderConfig> = {
    echolens: { id: 'echolens', label: 'EchoLens Agent', command: process.execPath, args: ['--import', 'tsx', path.join(root, 'src/echolens-runner.ts'), '{prompt}'] },
    'local-sim': { id: 'local-sim', label: '本地模拟' },
    codex: { id: 'codex', label: 'Codex CLI', command: 'codex', args: ['exec', '--ephemeral', '--sandbox', 'workspace-write', '--json', '{prompt}'] },
    claude: { id: 'claude', label: 'Claude Code', command: 'claude', args: ['-p', '{prompt}'] },
    cloudecode: { id: 'cloudecode', label: 'Cloudecode', command: 'cloudecode', args: ['{prompt}'] },
  };
  const seen = new Set<ProviderConfig['id']>();
  return requested.flatMap((item) => {
    if (seen.has(item.id) || !known[item.id]) return [];
    seen.add(item.id);
    return [{ ...known[item.id], enabled: item.enabled !== false }];
  });
}

function runQuality(): Promise<{ passed: boolean; durationMs: number; output: string }> {
  const started = Date.now();
  return new Promise((resolve) => {
    const command = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const child = spawn(command, ['run', 'check:ci'], { cwd: repoRoot, shell: false, windowsHide: true });
    let output = '';
    const append = (chunk: unknown) => { output = `${output}${String(chunk)}`.slice(-64 * 1024); };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    child.on('error', (error) => resolve({ passed: false, durationMs: Date.now() - started, output: error.message }));
    child.on('close', (code) => resolve({ passed: code === 0, durationMs: Date.now() - started, output }));
  });
}

function assertSameOrigin(request: import('node:http').IncomingMessage, url: URL): void {
  const origin = request.headers.origin;
  if (origin && origin !== url.origin) throw new Error('拒绝跨来源请求');
}

function resolveWorkspace(value: string): string {
  const workspace = path.resolve(repoRoot, value);
  const relative = path.relative(repoRoot, workspace);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('仓库路径必须位于 AGENT_TEST_REPO_ROOT 内');
  }
  return workspace;
}
