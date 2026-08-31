export type SandboxIsolation = 'high' | 'limited';
export type SandboxNetworkMode = 'none' | 'allowlist';
export type SandboxWorkspaceAccess = 'read-only' | 'read-write';
export type SandboxCommandKind = 'shell' | 'test' | 'build' | 'package_install';

export interface SandboxCapabilities {
  adapter: string;
  isolation: SandboxIsolation;
  networkModes: readonly SandboxNetworkMode[];
  resourceLimits: boolean;
  artifactCollection: boolean;
  hostExecution: boolean;
}

export interface SandboxMount {
  hostPath: string;
  containerPath: string;
  access: SandboxWorkspaceAccess;
}

export interface SandboxResources {
  timeoutMs: number;
  memoryMiB: number;
  cpuCount: number;
  processLimit: number;
  maxOutputBytes: number;
}

export interface SandboxNetworkPolicy {
  mode: SandboxNetworkMode;
  allowedDomains?: readonly string[];
  allowedPorts?: readonly number[];
}

export interface SandboxCommand {
  executable: string;
  args: readonly string[];
}

export interface SandboxExecuteRequest {
  kind: SandboxCommandKind;
  command: SandboxCommand;
  workspaceRoot: string;
  cwd: string;
  workspaceAccess: SandboxWorkspaceAccess;
  network: SandboxNetworkPolicy;
  resources: SandboxResources;
  artifactPaths?: readonly string[];
}

export interface SandboxArtifact {
  path: string;
  kind: 'workspace-change' | 'requested';
  change?: 'added' | 'modified' | 'deleted';
  mediaType?: string;
  size?: number;
  sha256?: string;
  storedPath?: string;
}

export interface SandboxPatchProposal {
  version: 1;
  operations: unknown[];
}

export interface SandboxExecuteResult {
  status: 'passed' | 'failed' | 'timeout' | 'cancelled';
  exitCode?: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  outputTruncated: boolean;
  containerId?: string;
  artifactBundleId?: string;
  artifacts: SandboxArtifact[];
  patch?: SandboxPatchProposal;
  warnings?: string[];
}

/**
 * 沙箱执行边界接口：在隔离容器（Docker）中运行不可信命令，宿主不直接执行。
 *
 * 实现必须保证 execute 只在受控隔离内运行、不降级到宿主 Shell（hostExecution 固定为 false）；
 * 失败时抛出 SandboxError，携带稳定错误码供调用方分支判断。
 */
export interface SandboxAdapter {
  readonly capabilities: SandboxCapabilities;
  execute(request: SandboxExecuteRequest, signal?: AbortSignal): Promise<SandboxExecuteResult>;
}

// SandboxError 的稳定错误码契约：调用方按 code 分支处理，不依赖错误消息文本。
export type SandboxErrorCode =
  | 'sandbox_unavailable'
  | 'sandbox_invalid_request'
  | 'sandbox_network_denied'
  | 'sandbox_stage_failed'
  | 'sandbox_artifact_failed'
  | 'sandbox_launch_failed';

export class SandboxError extends Error {
  constructor(readonly code: SandboxErrorCode, message: string) {
    super(message);
    this.name = 'SandboxError';
  }
}
