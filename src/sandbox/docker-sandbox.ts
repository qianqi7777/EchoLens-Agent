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
    // 镜像名会出现在 docker argv 的镜像位，proxyImage 亦被 sidecar 使用；若含空格、逗号或以“-”开头，
    // docker 会把它解析成额外选项而破坏参数语义。配置来自外部时按字符白名单校验并强制首字母为 alnum；
    // executable 仅拒绝空值与 NUL/CRLF，避免把换行等控制字符带进 argv。
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
    // cwd 先用 PathPolicy 解析为工作区内规范路径，再换成容器内的 /workspace 正斜杠相对路径；
    // Windows 下把反斜杠归一化为正斜杠，容器内始终按 POSIX 语义定位工作目录。
    const relativeCwd = path.relative(policy.workspaceRoot, cwd.canonicalPath).replaceAll('\\', '/');
    const workdir = relativeCwd ? `/workspace/${relativeCwd}` : '/workspace';
    const name = `echolens-${randomUUID()}`;
    const staged = await this.stager.prepare(policy.workspaceRoot, name);
    let networkResources: DockerNetworkResources | undefined;
    try {
      await mkdir(path.join(staged.root, ...relativeCwd.split('/').filter(Boolean)), { recursive: true });
      // docker --mount 使用逗号分隔 src/dst/readonly 等字段；暂存路径含逗号会拆分字段并可能被当作
      // 额外选项，故在此拒绝（代理脚本与策略路径在 prepareAllowedNetwork 中也做同样校验）。
      if (staged.root.includes(',')) {
        throw new SandboxError('sandbox_invalid_request', 'Docker --mount 暂不支持包含逗号的暂存路径');
      }
      const mountMode = request.workspaceAccess === 'read-only' ? ',readonly' : '';
      if (networkPolicy.mode === 'allowlist') {
        networkResources = await this.prepareAllowedNetwork(name, staged.root, networkPolicy, request.resources);
      }
      // 容器启动参数直接走 argv、不经宿主 Shell。强制高隔离：网络为 none 或仅内部网络、根文件系统只读、
      // 去掉全部 capabilities、禁止提权，并限制 pid/内存/cpu/超时；这些都是硬编码白名单，不接收请求方
      // 自定义的 docker 选项，避免借容器内任意命令扩展到宿主或其他容器。
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
        // executable 与 argv 作为独立参数传入 docker 再启动容器内进程，全程不经过 Shell，无 Shell 展开；
        // executable 已由 validateRequest 限定为简单命令名，argv 已拒绝 NUL/CRLF，因此此处不构成命令注入点。
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
      // 容器带 --rm，但超时/取消时 docker CLI 已被中断、容器可能残留占用资源；
      // 这里按随机 name 显式 rm --force，保证失败路径也回收容器与网络资源。
      if (result.timedOut || result.cancelled) await this.cleanup(name);
      if (result.spawnError) {
        throw new SandboxError('sandbox_unavailable', 'Docker 不可用或未安装，未降级到宿主 Shell');
      }
      // docker run 自身以 125 报告启动失败（镜像缺失、daemon 错误等），需与容器内业务退出码区分，
      // 才能把“容器没起来”和“容器里命令失败”分别呈现给调用方。
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
    // 拓扑：工作负载只接入 internalNetwork（默认无外部路径），唯一出口是 egress 网络上的代理 sidecar，
    // 代理按 allowlist 域名+端口放行并拒绝私网/保留地址。用两个网段把“无外联”与“受控出口”分离，deny 为默认。
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

// 仅在启用 allowlist 网络时注入，把 HTTP/HTTPS 流量指向唯一出口代理；NO_PROXY 豁免 localhost 避免代理自环。
// 域名与端口已由 normalizeNetworkPolicy 校验，这里不开放额外配置。
function proxyEnvironment(): string[] {
  const value = 'http://egress-proxy:3128';
  return [
    '--env', `HTTP_PROXY=${value}`, '--env', `HTTPS_PROXY=${value}`,
    '--env', `http_proxy=${value}`, '--env', `https_proxy=${value}`,
    '--env', 'NO_PROXY=localhost,127.0.0.1', '--env', 'no_proxy=localhost,127.0.0.1',
  ];
}

// 网络 deny 为默认：只有 package_install 工具可以申请 allowlist，其余一律拒绝。
// 域名先做 ASCII/punycode 规范化并去除末尾点再套 DNS 主机名正则；端口做整数与范围校验，
// 并对域名与端口数量设上限，防止请求方用海量条目撑爆代理策略或扩大攻击面。
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

// 优先以当前非 root 的 uid:gid 运行容器以避免提权；无 POSIX getuid（如 Windows）或当前为 root 时
// 回退到非特权 65532:65532，保证容器内进程不持有 root 能力。
function defaultSandboxUser(): string {
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
  const gid = typeof process.getgid === 'function' ? process.getgid() : undefined;
  return uid !== undefined && gid !== undefined && uid !== 0 ? `${uid}:${gid}` : '65532:65532';
}

// trust 边界：request 由工具调用传入，可执行文件、argv、cwd、resources 均不可信。
// executable 必须是单个简单命令名（不能含路径或 Shell 语法）；argv 受数量/长度/字符约束且拒绝 NUL/CRLF；
// resources 设定上下限以防时间/内存/子进程耗尽。这些最终都成为容器启动参数。
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
