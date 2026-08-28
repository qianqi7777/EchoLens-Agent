import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { domainToASCII } from 'node:url';
import { PathPolicy, validateRelativePath } from '../runtime/path-policy.js';
import { collectSandboxArtifacts } from './artifact-store.js';
import { EGRESS_PROXY_SOURCE } from './egress-proxy.js';
import { NodeProcessRunner, type ProcessRunner } from './process-runner.js';
import { FileSystemWorkspaceStager, type WorkspaceStager } from './workspace-stager.js';
import {
  SandboxError,
  type SandboxAdapter,
  type SandboxCapabilities,
  type SandboxExecuteRequest,
  type SandboxExecuteResult,
} from './types.js';

export interface DockerSandboxOptions {
  executable?: string;
  image?: string;
  proxyImage?: string;
  user?: string;
  runner?: ProcessRunner;
  stager?: WorkspaceStager;
}

interface DockerNetworkResources {
  internalNetwork: string;
  egressNetwork: string;
  proxyName: string;
}

export class DockerSandboxAdapter implements SandboxAdapter {
  readonly capabilities: SandboxCapabilities = {
    adapter: 'docker',
    isolation: 'high',
    networkModes: ['none', 'allowlist'],
    resourceLimits: true,
    artifactCollection: true,
    hostExecution: false,
  };

  private readonly executable: string;
  private readonly image: string;
  private readonly proxyImage: string;
  private readonly user: string;
  private readonly runner: ProcessRunner;
  private readonly stager: WorkspaceStager;

  constructor(options: DockerSandboxOptions = {}) {
    this.executable = options.executable ?? 'docker';
    this.image = options.image ?? 'node:22-bookworm-slim';
    this.proxyImage = options.proxyImage ?? this.image;
    this.user = options.user ?? defaultSandboxUser();
    if (!this.executable || /[\0\r\n]/u.test(this.executable)) {
      throw new SandboxError('sandbox_invalid_request', 'Docker 可执行文件配置无效');
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,255}$/u.test(this.image)) {
      throw new SandboxError('sandbox_invalid_request', 'Sandbox 镜像名称无效');
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,255}$/u.test(this.proxyImage)) {
      throw new SandboxError('sandbox_invalid_request', 'Sandbox 代理镜像名称无效');
    }
    if (!/^\d{1,10}:\d{1,10}$/u.test(this.user)) {
      throw new SandboxError('sandbox_invalid_request', 'Sandbox 用户必须是 uid:gid');
    }
    this.runner = options.runner ?? new NodeProcessRunner();
    this.stager = options.stager ?? new FileSystemWorkspaceStager();
  }

  async execute(request: SandboxExecuteRequest, signal?: AbortSignal): Promise<SandboxExecuteResult> {
    validateRequest(request);
    const networkPolicy = normalizeNetworkPolicy(request);
    const policy = await PathPolicy.create(request.workspaceRoot);
    const cwd = await policy.resolveExisting(request.cwd, 'directory');
    const relativeCwd = path.relative(policy.workspaceRoot, cwd.canonicalPath).replaceAll('\\', '/');
    const workdir = relativeCwd ? `/workspace/${relativeCwd}` : '/workspace';
    const name = `echolens-${randomUUID()}`;
    const staged = await this.stager.prepare(policy.workspaceRoot, name);
    let networkResources: DockerNetworkResources | undefined;
    try {
      await mkdir(path.join(staged.root, ...relativeCwd.split('/').filter(Boolean)), { recursive: true });
      if (staged.root.includes(',')) {
        throw new SandboxError('sandbox_invalid_request', 'Docker --mount 暂不支持包含逗号的暂存路径');
      }
      const mountMode = request.workspaceAccess === 'read-only' ? ',readonly' : '';
      if (networkPolicy.mode === 'allowlist') {
        networkResources = await this.prepareAllowedNetwork(name, staged.root, networkPolicy, request.resources);
      }
      const dockerArgs = [
        'run', '--rm', '--pull', 'never', '--name', name, '--init',
        '--network', networkResources?.internalNetwork ?? 'none', '--read-only', '--cap-drop', 'ALL',
        '--security-opt', 'no-new-privileges:true', '--user', this.user,
        '--pids-limit', String(request.resources.processLimit),
        '--memory', `${request.resources.memoryMiB}m`,
        '--cpus', String(request.resources.cpuCount),
        '--tmpfs', '/tmp:rw,noexec,nosuid,size=64m',
        '--mount', `type=bind,src=${staged.root},dst=/workspace${mountMode}`,
        '--workdir', workdir,
        '--env', 'CI=1', '--env', 'NO_COLOR=1',
        ...(networkResources ? proxyEnvironment() : []),
        this.image,
        request.command.executable,
        ...request.command.args,
      ];
      const result = await this.runner.run({
        executable: this.executable,
        args: dockerArgs,
        timeoutMs: request.resources.timeoutMs,
        maxOutputBytes: request.resources.maxOutputBytes,
        signal,
      });
      if (result.timedOut || result.cancelled) await this.cleanup(name);
      if (result.spawnError) {
        throw new SandboxError('sandbox_unavailable', 'Docker 不可用或未安装，未降级到宿主 Shell');
      }
      if (result.exitCode === 125) {
        throw new SandboxError('sandbox_launch_failed', 'Docker Sandbox 启动失败，请检查镜像与 Docker 服务状态');
      }
      const collection = request.workspaceAccess === 'read-write' || request.artifactPaths?.length
        ? await collectSandboxArtifacts({
          workspaceRoot: policy.workspaceRoot,
          staged,
          id: name,
          requestedPaths: request.artifactPaths,
        })
        : undefined;
      return {
        status: result.timedOut ? 'timeout' : result.cancelled ? 'cancelled' : result.exitCode === 0 ? 'passed' : 'failed',
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        durationMs: result.durationMs,
        outputTruncated: result.outputTruncated,
        artifactBundleId: collection?.id,
        artifacts: collection?.artifacts ?? [],
        patch: collection?.patch,
        warnings: collection?.warnings,
      };
    } finally {
      if (networkResources) await this.cleanupNetwork(networkResources);
      await staged.cleanup();
    }
  }

  private async prepareAllowedNetwork(
    name: string,
    stagedRoot: string,
    policy: Extract<ReturnType<typeof normalizeNetworkPolicy>, { mode: 'allowlist' }>,
    resources: SandboxExecuteRequest['resources'],
  ): Promise<DockerNetworkResources> {
    const suffix = name.slice('echolens-'.length, 'echolens-'.length + 12);
    const network: DockerNetworkResources = {
      internalNetwork: `echolens-${suffix}-internal`,
      egressNetwork: `echolens-${suffix}-egress`,
      proxyName: `echolens-${suffix}-proxy`,
    };
    const proxyRoot = path.join(path.dirname(stagedRoot), 'proxy');
    const proxyScript = path.join(proxyRoot, 'proxy.mjs');
    const proxyPolicy = path.join(proxyRoot, 'policy.json');
    await mkdir(proxyRoot, { recursive: true });
    await writeFile(proxyScript, EGRESS_PROXY_SOURCE, { encoding: 'utf8', mode: 0o644 });
    await writeFile(proxyPolicy, `${JSON.stringify(policy)}\n`, { encoding: 'utf8', mode: 0o644 });
    if (proxyScript.includes(',') || proxyPolicy.includes(',')) {
      throw new SandboxError('sandbox_invalid_request', 'Docker --mount 暂不支持包含逗号的代理路径');
    }
    try {
      await this.control(['network', 'create', '--internal', '--label', `echolens.sandbox=${name}`, network.internalNetwork]);
      await this.control(['network', 'create', '--label', `echolens.sandbox=${name}`, network.egressNetwork]);
      await this.control([
        'run', '--detach', '--rm', '--pull', 'never', '--name', network.proxyName,
        '--network', network.egressNetwork, '--read-only', '--cap-drop', 'ALL',
        '--security-opt', 'no-new-privileges:true', '--user', this.user,
        '--pids-limit', '64', '--memory', `${Math.min(resources.memoryMiB, 256)}m`, '--cpus', '0.5',
        '--tmpfs', '/tmp:rw,noexec,nosuid,size=16m',
        '--mount', `type=bind,src=${proxyScript},dst=/opt/echolens/proxy.mjs,readonly`,
        '--mount', `type=bind,src=${proxyPolicy},dst=/opt/echolens/policy.json,readonly`,
        this.proxyImage, 'node', '/opt/echolens/proxy.mjs', '/opt/echolens/policy.json',
      ]);
      await this.control(['network', 'connect', '--alias', 'egress-proxy', network.internalNetwork, network.proxyName]);
      await this.waitForProxy(network.proxyName);
      return network;
    } catch (error) {
      await this.cleanupNetwork(network);
      throw error;
    }
  }

  private async waitForProxy(proxyName: string): Promise<void> {
    const check = "const n=require('node:net');const s=n.connect(3128,'127.0.0.1',()=>{s.end();process.exit(0)});s.on('error',()=>process.exit(1));setTimeout(()=>process.exit(1),500)";
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const result = await this.runner.run({
        executable: this.executable,
        args: ['exec', proxyName, 'node', '-e', check],
        timeoutMs: 2_000,
        maxOutputBytes: 2_048,
      });
      if (!result.spawnError && result.exitCode === 0) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new SandboxError('sandbox_launch_failed', '受控网络代理未能就绪');
  }

  private async control(args: readonly string[]): Promise<void> {
    const result = await this.runner.run({
      executable: this.executable,
      args,
      timeoutMs: 15_000,
      maxOutputBytes: 8_192,
    });
    if (result.spawnError) throw new SandboxError('sandbox_unavailable', 'Docker 不可用或未安装');
    if (result.exitCode !== 0) throw new SandboxError('sandbox_launch_failed', 'Docker 受控网络初始化失败');
  }

  private async cleanupNetwork(network: DockerNetworkResources): Promise<void> {
    await this.runner.run({
      executable: this.executable,
      args: ['rm', '--force', network.proxyName],
      timeoutMs: 5_000,
      maxOutputBytes: 2_048,
    }).catch(() => undefined);
    for (const name of [network.internalNetwork, network.egressNetwork]) {
      await this.runner.run({
        executable: this.executable,
        args: ['network', 'rm', name],
        timeoutMs: 5_000,
        maxOutputBytes: 2_048,
      }).catch(() => undefined);
    }
  }

  private async cleanup(name: string): Promise<void> {
    await this.runner.run({
      executable: this.executable,
      args: ['rm', '--force', name],
      timeoutMs: 5_000,
      maxOutputBytes: 4_096,
    }).catch(() => undefined);
  }
}

function proxyEnvironment(): string[] {
  const value = 'http://egress-proxy:3128';
  return [
    '--env', `HTTP_PROXY=${value}`, '--env', `HTTPS_PROXY=${value}`,
    '--env', `http_proxy=${value}`, '--env', `https_proxy=${value}`,
    '--env', 'NO_PROXY=localhost,127.0.0.1', '--env', 'no_proxy=localhost,127.0.0.1',
  ];
}

function normalizeNetworkPolicy(request: SandboxExecuteRequest):
  | { mode: 'none' }
  | { mode: 'allowlist'; allowedDomains: string[]; allowedPorts: number[] } {
  if (request.network.mode === 'none') return { mode: 'none' };
  if (request.kind !== 'package_install') {
    throw new SandboxError('sandbox_network_denied', '只有 package_install 工具可以请求受控网络');
  }
  const domains = [...new Set((request.network.allowedDomains ?? []).map((value) => {
    const domain = domainToASCII(value.trim().toLowerCase().replace(/\.$/u, ''));
    if (!domain || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/u.test(domain)) {
      throw new SandboxError('sandbox_invalid_request', `网络域名无效：${value}`);
    }
    return domain;
  }))].sort();
  const ports = [...new Set(request.network.allowedPorts ?? [])].sort((a, b) => a - b);
  if (domains.length === 0 || domains.length > 16 || ports.length === 0 || ports.length > 8
    || ports.some((port) => !Number.isInteger(port) || port < 1 || port > 65535)) {
    throw new SandboxError('sandbox_invalid_request', '网络 allowlist 的域名或端口数量无效');
  }
  return { mode: 'allowlist', allowedDomains: domains, allowedPorts: ports };
}

function defaultSandboxUser(): string {
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
  const gid = typeof process.getgid === 'function' ? process.getgid() : undefined;
  return uid !== undefined && gid !== undefined && uid !== 0 ? `${uid}:${gid}` : '65532:65532';
}

function validateRequest(request: SandboxExecuteRequest): void {
  validateRelativePath(request.cwd);
  if (!/^[A-Za-z0-9._+-]{1,128}$/u.test(request.command.executable)) {
    throw new SandboxError('sandbox_invalid_request', '可执行文件必须是简单命令名，不能包含路径或 Shell 语法');
  }
  if (request.command.args.length > 128 || request.command.args.some((value) => value.length > 8_192 || /[\0\r\n]/u.test(value))) {
    throw new SandboxError('sandbox_invalid_request', 'argv 数量、长度或字符不符合安全限制');
  }
  const resources = request.resources;
  if (!Number.isInteger(resources.timeoutMs) || resources.timeoutMs < 100 || resources.timeoutMs > 600_000
    || !Number.isInteger(resources.memoryMiB) || resources.memoryMiB < 64 || resources.memoryMiB > 8_192
    || !Number.isFinite(resources.cpuCount) || resources.cpuCount <= 0 || resources.cpuCount > 8
    || !Number.isInteger(resources.processLimit) || resources.processLimit < 8 || resources.processLimit > 1_024
    || !Number.isInteger(resources.maxOutputBytes) || resources.maxOutputBytes < 1_024 || resources.maxOutputBytes > 1_048_576) {
    throw new SandboxError('sandbox_invalid_request', 'Sandbox 资源限制超出允许范围');
  }
}
