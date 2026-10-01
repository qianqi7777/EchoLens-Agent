import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { ProcessRunner, ProcessRunResult } from './process-runner.js';
import { NodeProcessRunner } from './process-runner.js';

export type SandboxPreflightStatus =
  | 'ready'
  | 'docker_cli_missing'
  | 'docker_engine_unavailable'
  | 'image_missing'
  | 'image_inspect_failed'
  | 'smoke_test_failed'
  | 'invalid_configuration';

export type SandboxAutoPullPolicy = 'prompt' | 'off' | 'on';

export interface SandboxImageEvidence {
  reference: string;
  imageId?: string;
  repoDigests: string[];
  inspected: boolean;
  error?: string;
}

export interface SandboxPreflightResult {
  version: 1;
  ok: boolean;
  status: SandboxPreflightStatus;
  checkedAt: string;
  docker?: { context?: string; serverVersion?: string };
  images: SandboxImageEvidence[];
  smokeTest?: { image: string; ok: boolean; exitCode?: number; stdout?: string; stderr?: string };
  failureReason?: string;
  commands: string[];
}

export interface SandboxPreflightOptions {
  projectRoot?: string;
  executable?: string;
  image?: string;
  proxyImage?: string;
  expectedContext?: string;
  runner?: ProcessRunner;
  timeoutMs?: number;
  maxOutputBytes?: number;
  signal?: AbortSignal;
  persist?: boolean;
}

export interface PrepareSandboxImagesOptions extends SandboxPreflightOptions {
  pullTimeoutMs?: number;
  autoPull?: SandboxAutoPullPolicy;
  confirmPull?: (images: readonly string[]) => Promise<boolean>;
  notify?: (message: string) => void;
}

const DEFAULT_IMAGE = 'node:22-bookworm-slim';
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_OUTPUT_BYTES = 32 * 1024;

/**
 * 启动时的 Docker 真实性检查。所有命令都使用独立 argv，调用方不能注入 Docker 参数，
 * 也不会在 Docker 失败时降级到宿主 Shell。
 */
export async function runSandboxPreflight(options: SandboxPreflightOptions = {}): Promise<SandboxPreflightResult> {
  const executable = options.executable ?? 'docker';
  const image = options.image ?? DEFAULT_IMAGE;
  const proxyImage = options.proxyImage ?? image;
  const checkedAt = new Date().toISOString();
  const images: SandboxImageEvidence[] = [];
  const base: SandboxPreflightResult = {
    version: 1, ok: false, status: 'invalid_configuration', checkedAt, images, commands: repairCommands(image, proxyImage),
  };
  if (!validExecutable(executable) || !validImage(image) || !validImage(proxyImage)
    || (options.expectedContext !== undefined && !validContext(options.expectedContext))) {
    return await finish(options, { ...base, status: 'invalid_configuration', failureReason: 'Sandbox 配置无效' });
  }

  const runner = options.runner ?? new NodeProcessRunner();
  const cli = await runDocker(runner, executable, ['--version'], options);
  if (cli.spawnError) {
    return await finish(options, { ...base, status: 'docker_cli_missing', failureReason: 'Docker CLI 不存在或不可执行' });
  }
  const version = await runDocker(runner, executable, ['version', '--format', '{{json .Server}}'], options);
  const info = await runDocker(runner, executable, ['info', '--format', '{{json .}}'], options);
  if (version.spawnError || info.spawnError || version.exitCode !== 0 || info.exitCode !== 0) {
    return await finish(options, {
      ...base,
      status: 'docker_engine_unavailable',
      failureReason: trimReason(info.stderr || version.stderr || 'Docker Engine 不可连接'),
    });
  }
  const contextResult = await runDocker(runner, executable, ['context', 'show'], options);
  if (contextResult.spawnError || contextResult.exitCode !== 0) {
    return await finish(options, { ...base, status: 'docker_engine_unavailable', failureReason: '无法读取 Docker context' });
  }
  const context = contextResult.stdout.trim();
  const serverVersion = parseServerVersion(version.stdout, info.stdout);
  base.docker = { context, serverVersion };
  if (options.expectedContext && context !== options.expectedContext) {
    return await finish(options, {
      ...base,
      status: 'invalid_configuration',
      failureReason: `Docker context 不匹配：当前 ${context}，期望 ${options.expectedContext}`,
    });
  }

  for (const reference of unique([image, proxyImage])) {
    const inspected = await runDocker(runner, executable, ['image', 'inspect', reference, '--format', '{{json .}}'], options);
    if (inspected.spawnError) {
      return await finish(options, { ...base, status: 'image_inspect_failed', failureReason: 'Docker image inspect 无法执行' });
    }
    if (inspected.exitCode !== 0) {
      const missing = /no such image|not found|does not exist/iu.test(inspected.stderr);
      const evidence: SandboxImageEvidence = { reference, repoDigests: [], inspected: false, error: trimReason(inspected.stderr || '镜像检查失败') };
      images.push(evidence);
      return await finish(options, {
        ...base,
        status: missing ? 'image_missing' : 'image_inspect_failed',
        failureReason: missing ? `缺少 Sandbox 镜像：${reference}` : `镜像检查失败：${reference}`,
      });
    }
    try {
      const parsed = JSON.parse(inspected.stdout) as { Id?: unknown; RepoDigests?: unknown };
      const repoDigests = Array.isArray(parsed.RepoDigests)
        ? parsed.RepoDigests.filter((value): value is string => typeof value === 'string')
        : [];
      images.push({ reference, imageId: typeof parsed.Id === 'string' ? parsed.Id : undefined, repoDigests, inspected: true });
    } catch {
      return await finish(options, { ...base, status: 'image_inspect_failed', failureReason: `无法解析镜像摘要：${reference}` });
    }
  }

  const smoke = await runDocker(runner, executable, [
    'run', '--rm', '--pull', 'never', '--network', 'none', '--read-only', '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges:true', image, 'node', '--version',
  ], options);
  const smokeTest = {
    image,
    ok: !smoke.spawnError && smoke.exitCode === 0,
    ...(smoke.exitCode === undefined ? {} : { exitCode: smoke.exitCode }),
    stdout: smoke.stdout,
    stderr: smoke.stderr,
  };
  if (!smokeTest.ok) {
    return await finish(options, { ...base, status: 'smoke_test_failed', smokeTest, failureReason: trimReason(smoke.stderr || 'Sandbox smoke test 失败') });
  }
  return await finish(options, { ...base, ok: true, status: 'ready', smokeTest });
}

/** 仅由启动引导或明确的准备命令调用；普通工具执行路径不得调用此函数。 */
export async function prepareSandboxImages(options: PrepareSandboxImagesOptions = {}): Promise<SandboxPreflightResult> {
  const policy = options.autoPull ?? parseAutoPullPolicy(process.env.AGENT_SANDBOX_AUTO_PULL);
  const initial = await runSandboxPreflight(options);
  if (initial.ok || initial.status !== 'image_missing') return initial;
  const missing = initial.images.filter((item) => !item.inspected).map((item) => item.reference);
  if (policy === 'off') return initial;
  if (policy === 'prompt') {
    const confirmed = options.confirmPull ? await options.confirmPull(missing) : false;
    if (!confirmed) return initial;
  }
  options.notify?.(`正在准备 Sandbox 镜像：${missing.join(', ')}`);
  const runner = options.runner ?? new NodeProcessRunner();
  for (const reference of missing) {
    const pulled = await runDocker(
      runner,
      options.executable ?? 'docker',
      ['pull', reference],
      { ...options, timeoutMs: options.pullTimeoutMs ?? 10 * 60_000 },
    );
    if (pulled.spawnError || pulled.exitCode !== 0) {
      const detail = pulled.timedOut
        ? `超过 ${Math.round((options.pullTimeoutMs ?? 10 * 60_000) / 1000)} 秒超时`
        : trimReason(pulled.stderr || pulled.stdout || pulled.spawnError || `退出码 ${pulled.exitCode ?? 'unknown'}`);
      return finish(options, {
        ...initial,
        status: 'image_missing',
        failureReason: `镜像下载失败：${reference}（${detail}）`,
      });
    }
  }
  // pull 成功不能视为可用，必须重新 inspect 并执行 smoke test。
  return runSandboxPreflight(options);
}

export function parseAutoPullPolicy(value: string | undefined): SandboxAutoPullPolicy {
  return value === 'off' || value === 'on' || value === 'prompt' ? value : 'prompt';
}

export function preflightEvidencePath(projectRoot: string): string {
  return resolve(projectRoot, '.echolens', 'sandbox', 'preflight.json');
}

async function finish(options: SandboxPreflightOptions, result: SandboxPreflightResult): Promise<SandboxPreflightResult> {
  if (options.persist !== false && options.projectRoot) {
    try {
      const destination = preflightEvidencePath(options.projectRoot);
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, `${JSON.stringify(result, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    } catch {
      // 诊断证据不可写不应改变 Sandbox 的真实判定。
    }
  }
  return result;
}

async function runDocker(runner: ProcessRunner, executable: string, args: readonly string[], options: SandboxPreflightOptions): Promise<ProcessRunResult> {
  return runner.run({
    executable,
    args,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxOutputBytes: options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
    signal: options.signal,
  });
}

function repairCommands(image: string, proxyImage: string): string[] {
  const commands = process.platform === 'win32'
    ? ['winget install --id Docker.DockerDesktop -e', 'docker info']
    : ['docker info'];
  for (const reference of unique([image, proxyImage])) commands.push(`docker pull ${reference}`);
  commands.push('npm run verify:docker');
  return commands;
}

function parseServerVersion(version: string, info: string): string | undefined {
  for (const raw of [version, info]) {
    try {
      const parsed = JSON.parse(raw) as { Version?: unknown; ServerVersion?: unknown };
      const value = parsed.Version ?? parsed.ServerVersion;
      if (typeof value === 'string' && value) return value;
    } catch { /* Docker output can be plain text on older versions. */ }
  }
  const match = info.match(/Server Version:\s*([^\r\n]+)/u);
  return match?.[1]?.trim();
}

function trimReason(value: string): string { return value.replace(/[\r\n]+/gu, ' ').trim().slice(0, 500); }
function unique(values: readonly string[]): string[] { return [...new Set(values)]; }
function validExecutable(value: string): boolean { return Boolean(value) && !/[\0\r\n]/u.test(value); }
function validImage(value: string): boolean { return /^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,255}$/u.test(value); }
function validContext(value: string): boolean { return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value); }
