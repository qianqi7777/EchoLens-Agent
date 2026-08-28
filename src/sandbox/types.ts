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
}

export interface SandboxArtifact {
  path: string;
  mediaType?: string;
  size?: number;
  sha256?: string;
}

export interface SandboxExecuteResult {
  status: 'passed' | 'failed' | 'timeout' | 'cancelled';
  exitCode?: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  outputTruncated: boolean;
  containerId?: string;
  artifacts: SandboxArtifact[];
}

export interface SandboxAdapter {
  readonly capabilities: SandboxCapabilities;
  execute(request: SandboxExecuteRequest, signal?: AbortSignal): Promise<SandboxExecuteResult>;
}

export type SandboxErrorCode =
  | 'sandbox_unavailable'
  | 'sandbox_invalid_request'
  | 'sandbox_network_denied'
  | 'sandbox_stage_failed'
  | 'sandbox_launch_failed';

export class SandboxError extends Error {
  constructor(readonly code: SandboxErrorCode, message: string) {
    super(message);
    this.name = 'SandboxError';
  }
}
