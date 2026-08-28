import type { JsonSchema, JsonSchemaNode, ToolContext, ToolResult } from './types.js';
import { ToolRegistry } from './tool-registry.js';
import { toolFailure, toolSuccess } from './tool-result.js';
import { runVerification, selectVerificationPlan, type EditVerificationResult } from './verification.js';
import { applyStructuredPatch } from './workspace-tools.js';
import {
  loadSandboxArtifactBundle,
  SandboxError,
  type SandboxAdapter,
  type SandboxCommandKind,
  type SandboxExecuteRequest,
  type SandboxExecuteResult,
  type SandboxWorkspaceAccess,
} from '../sandbox/index.js';

const pathProperty: JsonSchemaNode = { type: 'string', minLength: 1, maxLength: 4096 };
const argvProperty: JsonSchemaNode = {
  type: 'array', maxItems: 128,
  items: { type: 'string', maxLength: 8192, pattern: '^[^\\u0000\\r\\n]*$' },
};
const artifactPathsProperty: JsonSchemaNode = {
  type: 'array', maxItems: 32, items: pathProperty,
};

export interface SandboxToolOptions {
  defaultTimeoutMs?: number;
  defaultMemoryMiB?: number;
  defaultCpuCount?: number;
  defaultProcessLimit?: number;
  defaultMaxOutputBytes?: number;
}

export function registerSandboxTools(
  registry: ToolRegistry,
  sandbox: SandboxAdapter,
  options: SandboxToolOptions = {},
): void {
  registry.register({
    name: 'shell_exec',
    description: '在高隔离 Sandbox 中执行单个 argv 命令；不经过宿主 Shell，默认禁止网络。',
    permission: 'process.exec',
    effect: 'process',
    inputSchema: schema({
      executable: { type: 'string', pattern: '^[A-Za-z0-9._+-]{1,128}$' },
      args: argvProperty,
      cwd: pathProperty,
      workspaceAccess: { type: 'string', enum: ['read-only', 'read-write'] },
      artifactPaths: artifactPathsProperty,
      timeoutMs: { type: 'integer', minimum: 100, maximum: 600_000 },
    }, ['executable']),
    execute: (args, context) => executeSandbox(sandbox, 'shell', args, context, options),
  });
  registry.register({
    name: 'apply_sandbox_patch',
    description: '按 Artifact Bundle ID 应用 Sandbox 生成的结构化 Patch；仍需写审批、Checkpoint 和后状态校验。',
    permission: 'workspace.write',
    effect: 'write',
    inputSchema: schema({
      bundleId: { type: 'string', pattern: '^[a-f0-9-]{36}$' },
    }, ['bundleId']),
    execute: applySandboxPatch,
  });
  registry.register({
    name: 'run_tests',
    description: '在高隔离 Sandbox 中运行 npm 测试脚本，默认禁止网络。',
    permission: 'process.exec',
    effect: 'process',
    inputSchema: scriptSchema(),
    execute: (args, context) => executePackageScript(sandbox, 'test', args, context, options),
  });
  registry.register({
    name: 'run_build',
    description: '在高隔离 Sandbox 中运行 npm 构建脚本，默认禁止网络。',
    permission: 'process.exec',
    effect: 'process',
    inputSchema: scriptSchema(),
    execute: (args, context) => executePackageScript(sandbox, 'build', args, context, options),
  });
  registry.register({
    name: 'package_install',
    description: '请求在 Sandbox 中安装 npm 包；需要网络权限与域名策略，未配置时失败关闭。',
    permission: 'network.request',
    effect: 'network',
    inputSchema: schema({
      packages: { type: 'array', minItems: 1, maxItems: 32, items: { type: 'string', minLength: 1, maxLength: 256, pattern: '^(?!-)[A-Za-z0-9@._/~-]+$' } },
      dev: { type: 'boolean' },
      cwd: pathProperty,
      allowedDomains: { type: 'array', minItems: 1, maxItems: 16, items: { type: 'string', minLength: 1, maxLength: 253, pattern: '^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\\.)+[A-Za-z]{2,63}$' } },
      timeoutMs: { type: 'integer', minimum: 1_000, maximum: 600_000 },
    }, ['packages', 'allowedDomains']),
    execute: (args, context) => executePackageInstall(sandbox, args, context, options),
  });
  registry.register({
    name: 'verify_changes',
    description: '根据改动文件在高隔离 Sandbox 中运行受控类型检查和测试。',
    permission: 'process.exec',
    effect: 'process',
    inputSchema: schema({
      changedFiles: { type: 'array', maxItems: 128, items: pathProperty },
    }, []),
    execute: (args, context) => executeVerification(sandbox, args, context, options),
  });
}

async function executeVerification(
  sandbox: SandboxAdapter,
  args: Record<string, unknown>,
  context: ToolContext,
  options: SandboxToolOptions,
): Promise<ToolResult> {
  const changedFiles = Array.isArray(args.changedFiles)
    ? args.changedFiles.filter((value): value is string => typeof value === 'string')
    : [];
  const plan = await selectVerificationPlan(context.workspaceRoot, changedFiles);
  if (plan.commands.length === 0) return toolSuccess(plan.reason, '没有可运行的验证项');
  const results = await runVerification(plan, {
    signal: context.signal,
    runCommand: async (command, signal) => {
      try {
        const executed = await sandbox.execute({
          kind: 'test',
          command: {
            executable: command.executable.replace(/\.cmd$/iu, ''),
            args: command.args,
          },
          workspaceRoot: context.workspaceRoot,
          cwd: '.',
          workspaceAccess: 'read-write',
          network: { mode: 'none' },
          resources: resources(command.timeoutMs, options),
        }, signal);
        return verificationResult(command, executed);
      } catch (error) {
        return {
          id: command.id,
          label: command.label,
          command: command.command,
          status: 'failed',
          durationMs: 0,
          summary: error instanceof SandboxError ? error.message : 'Sandbox 验证失败',
        };
      }
    },
  });
  const content = results.map((result) => `${result.id}: ${result.status} - ${result.summary}`).join('\n');
  const failed = results.some((result) => result.status === 'failed' || result.status === 'timeout');
  return failed
    ? toolFailure('failed', 'verification_failed', content, { data: { verification: results } })
    : toolSuccess(content, 'Sandbox 验证完成', [], { verification: results });
}

async function executePackageScript(
  sandbox: SandboxAdapter,
  kind: 'test' | 'build',
  args: Record<string, unknown>,
  context: ToolContext,
  options: SandboxToolOptions,
): Promise<ToolResult> {
  const script = typeof args.script === 'string' ? args.script : kind;
  const extra = Array.isArray(args.args) ? args.args as string[] : [];
  return executeSandbox(sandbox, kind, {
    executable: 'npm',
    args: ['run', script, ...(extra.length ? ['--', ...extra] : [])],
    cwd: args.cwd,
    workspaceAccess: 'read-write',
    artifactPaths: Array.isArray(args.artifactPaths) ? args.artifactPaths as string[] : undefined,
    timeoutMs: args.timeoutMs,
  }, context, options);
}

async function executePackageInstall(
  sandbox: SandboxAdapter,
  args: Record<string, unknown>,
  context: ToolContext,
  options: SandboxToolOptions,
): Promise<ToolResult> {
  const packages = args.packages as string[];
  const allowedDomains = args.allowedDomains as string[];
  return executeSandboxRequest(sandbox, {
    kind: 'package_install',
    command: { executable: 'npm', args: ['install', ...(args.dev === true ? ['--save-dev'] : []), ...packages] },
    workspaceRoot: context.workspaceRoot,
    cwd: typeof args.cwd === 'string' ? args.cwd : '.',
    workspaceAccess: 'read-write',
    network: { mode: 'allowlist', allowedDomains, allowedPorts: [443] },
    resources: resources(args.timeoutMs, options),
    artifactPaths: Array.isArray(args.artifactPaths) ? args.artifactPaths as string[] : undefined,
  }, context);
}

async function applySandboxPatch(
  args: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolResult> {
  try {
    const bundle = await loadSandboxArtifactBundle(context.workspaceRoot, String(args.bundleId));
    if (!bundle.patch?.operations.length) {
      return toolFailure('invalid', 'patch_invalid', 'Artifact Bundle 不包含可应用的文本 Patch');
    }
    const applied = await applyStructuredPatch({ patch: bundle.patch }, context);
    return applied.status === 'ok'
      ? { ...applied, summary: `${applied.summary}，来源 bundle=${bundle.id}` }
      : applied;
  } catch (error) {
    if (error instanceof SandboxError) {
      return toolFailure('invalid', error.code, error.message);
    }
    return toolFailure('failed', 'tool_failed', '无法加载 Sandbox Patch');
  }
}

async function executeSandbox(
  sandbox: SandboxAdapter,
  kind: SandboxCommandKind,
  args: Record<string, unknown>,
  context: ToolContext,
  options: SandboxToolOptions,
): Promise<ToolResult> {
  return executeSandboxRequest(sandbox, {
    kind,
    command: {
      executable: String(args.executable),
      args: Array.isArray(args.args) ? args.args as string[] : [],
    },
    workspaceRoot: context.workspaceRoot,
    cwd: typeof args.cwd === 'string' ? args.cwd : '.',
    workspaceAccess: (args.workspaceAccess === 'read-write' ? 'read-write' : 'read-only') as SandboxWorkspaceAccess,
    network: { mode: 'none' },
    resources: resources(args.timeoutMs, options),
    artifactPaths: Array.isArray(args.artifactPaths) ? args.artifactPaths as string[] : undefined,
  }, context);
}

async function executeSandboxRequest(
  sandbox: SandboxAdapter,
  request: SandboxExecuteRequest,
  context: ToolContext,
): Promise<ToolResult> {
  try {
    const result = await sandbox.execute(request, context.signal);
    const content = [
      result.stdout ? `[stdout]\n${result.stdout}` : '',
      result.stderr ? `[stderr]\n${result.stderr}` : '',
      result.outputTruncated ? '[info] Sandbox 输出已达到上限并截断' : '',
      result.artifactBundleId ? `[artifacts]\nbundle=${result.artifactBundleId}\n${renderArtifacts(result.artifacts)}` : '',
      result.warnings?.map((warning) => `[warning] ${warning}`).join('\n') ?? '',
    ].filter(Boolean).join('\n');
    const data = {
      sandbox: sandbox.capabilities.adapter,
      isolation: sandbox.capabilities.isolation,
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      outputTruncated: result.outputTruncated,
      artifacts: result.artifacts,
      artifactBundleId: result.artifactBundleId,
      patchOperations: result.patch?.operations.length ?? 0,
    };
    if (result.status === 'passed') {
      return toolSuccess(content || '[info] 命令成功且没有输出', `${request.kind} 通过`, [`sandbox:${request.kind}`], data);
    }
    const status = result.status === 'timeout' ? 'timeout' : result.status === 'cancelled' ? 'cancelled' : 'failed';
    const code = result.status === 'timeout' ? 'timeout' : result.status === 'cancelled' ? 'cancelled' : 'command_failed';
    return toolFailure(status, code, `${request.kind} ${result.status}`, { data, evidenceIds: [`sandbox:${request.kind}`] });
  } catch (error) {
    if (error instanceof SandboxError) {
      const status = error.code === 'sandbox_invalid_request' ? 'invalid'
        : error.code === 'sandbox_network_denied' ? 'denied' : 'failed';
      return toolFailure(status, error.code, error.message, {
        data: { sandbox: sandbox.capabilities.adapter, isolation: sandbox.capabilities.isolation },
      });
    }
    return toolFailure('failed', 'sandbox_launch_failed', 'Sandbox 执行失败');
  }
}

function resources(timeout: unknown, options: SandboxToolOptions): SandboxExecuteRequest['resources'] {
  return {
    timeoutMs: typeof timeout === 'number' ? timeout : options.defaultTimeoutMs ?? 120_000,
    memoryMiB: options.defaultMemoryMiB ?? 1_024,
    cpuCount: options.defaultCpuCount ?? 2,
    processLimit: options.defaultProcessLimit ?? 128,
    maxOutputBytes: options.defaultMaxOutputBytes ?? 64 * 1_024,
  };
}

function verificationResult(
  command: { id: string; label: string; command: string },
  result: Awaited<ReturnType<SandboxAdapter['execute']>>,
): EditVerificationResult {
  const status = result.status === 'passed' ? 'passed'
    : result.status === 'timeout' ? 'timeout'
      : result.status === 'cancelled' ? 'skipped' : 'failed';
  return {
    id: command.id,
    label: command.label,
    command: command.command,
    status,
    exitCode: result.exitCode,
    durationMs: result.durationMs,
    summary: status === 'passed' ? 'Sandbox 验证通过'
      : status === 'timeout' ? 'Sandbox 验证超时'
        : status === 'skipped' ? 'Sandbox 验证已取消' : `Sandbox 验证失败（退出码 ${result.exitCode ?? 'unknown'}）`,
    output: [result.stdout, result.stderr].filter(Boolean).join('\n').slice(-4000),
  };
}

function scriptSchema(): JsonSchema {
  return schema({
    script: { type: 'string', minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9:_-]+$' },
    args: argvProperty,
    cwd: pathProperty,
    artifactPaths: artifactPathsProperty,
    timeoutMs: { type: 'integer', minimum: 100, maximum: 600_000 },
  }, []);
}

function renderArtifacts(artifacts: SandboxExecuteResult['artifacts']): string {
  if (!artifacts.length) return '[info] 没有收集到文件变化或请求 Artifact';
  return artifacts.map((artifact) => {
    const change = artifact.change ? ` ${artifact.change}` : '';
    return `${artifact.kind}${change}: ${artifact.path} (${artifact.size ?? 0} bytes, ${artifact.sha256 ?? 'no-hash'})`;
  }).join('\n');
}

function schema(properties: Record<string, JsonSchemaNode>, required: string[]): JsonSchema {
  return { type: 'object', properties, required, additionalProperties: false };
}
