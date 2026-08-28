import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import * as path from 'node:path';
import { PathPolicy, validateRelativePath } from '../runtime/path-policy.js';
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
  user?: string;
  runner?: ProcessRunner;
  stager?: WorkspaceStager;
}

export class DockerSandboxAdapter implements SandboxAdapter {
  readonly capabilities: SandboxCapabilities = {
    adapter: 'docker',
    isolation: 'high',
    networkModes: ['none'],
    resourceLimits: true,
    artifactCollection: false,
    hostExecution: false,
  };

  private readonly executable: string;
  private readonly image: string;
  private readonly user: string;
  private readonly runner: ProcessRunner;
  private readonly stager: WorkspaceStager;

  constructor(options: DockerSandboxOptions = {}) {
    this.executable = options.executable ?? 'docker';
    this.image = options.image ?? 'node:22-bookworm-slim';
    this.user = options.user ?? defaultSandboxUser();
    if (!this.executable || /[\0\r\n]/u.test(this.executable)) {
      throw new SandboxError('sandbox_invalid_request', 'Docker 可执行文件配置无效');
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,255}$/u.test(this.image)) {
      throw new SandboxError('sandbox_invalid_request', 'Sandbox 镜像名称无效');
    }
    if (!/^\d{1,10}:\d{1,10}$/u.test(this.user)) {
      throw new SandboxError('sandbox_invalid_request', 'Sandbox 用户必须是 uid:gid');
    }
    this.runner = options.runner ?? new NodeProcessRunner();
    this.stager = options.stager ?? new FileSystemWorkspaceStager();
  }

  async execute(request: SandboxExecuteRequest, signal?: AbortSignal): Promise<SandboxExecuteResult> {
    validateRequest(request);
    if (request.network.mode !== 'none') {
      throw new SandboxError('sandbox_network_denied', 'Docker Sandbox 当前只支持默认禁网；域名代理尚未配置');
    }
    const policy = await PathPolicy.create(request.workspaceRoot);
    const cwd = await policy.resolveExisting(request.cwd, 'directory');
    const relativeCwd = path.relative(policy.workspaceRoot, cwd.canonicalPath).replaceAll('\\', '/');
    const workdir = relativeCwd ? `/workspace/${relativeCwd}` : '/workspace';
    const name = `echolens-${randomUUID()}`;
    const staged = await this.stager.prepare(policy.workspaceRoot, name);
    try {
      await mkdir(path.join(staged.root, ...relativeCwd.split('/').filter(Boolean)), { recursive: true });
      if (staged.root.includes(',')) {
        throw new SandboxError('sandbox_invalid_request', 'Docker --mount 暂不支持包含逗号的暂存路径');
      }
      const mountMode = request.workspaceAccess === 'read-only' ? ',readonly' : '';
      const dockerArgs = [
        'run', '--rm', '--pull', 'never', '--name', name, '--init',
        '--network', 'none', '--read-only', '--cap-drop', 'ALL',
        '--security-opt', 'no-new-privileges:true', '--user', this.user,
        '--pids-limit', String(request.resources.processLimit),
        '--memory', `${request.resources.memoryMiB}m`,
        '--cpus', String(request.resources.cpuCount),
        '--tmpfs', '/tmp:rw,noexec,nosuid,size=64m',
        '--mount', `type=bind,src=${staged.root},dst=/workspace${mountMode}`,
        '--workdir', workdir,
        '--env', 'CI=1', '--env', 'NO_COLOR=1',
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
      return {
        status: result.timedOut ? 'timeout' : result.cancelled ? 'cancelled' : result.exitCode === 0 ? 'passed' : 'failed',
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        durationMs: result.durationMs,
        outputTruncated: result.outputTruncated,
        artifacts: [],
      };
    } finally {
      await staged.cleanup();
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
