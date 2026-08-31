import type { TrustLevel } from '../core/messages.js';
import type { Permission } from '../core/permissions.js';

export type InstructionSourceKind =
  | 'builtin_policy'
  | 'user_global'
  | 'project_root'
  | 'project_directory'
  | 'vendor_adapter';

export type InstructionFileKind =
  | 'agents_override'
  | 'agents'
  | 'configured_fallback'
  | 'vendor_specific';

export interface InstructionScope {
  workspaceRoot?: string;
  directory?: string;
  appliesTo: string;
  depth: number;
}

export interface InstructionSource {
  id: string;
  kind: InstructionSourceKind;
  fileKind?: InstructionFileKind;
  trust: Extract<TrustLevel, 'system' | 'user' | 'repository'>;
  uri?: string;
  adapterId?: string;
  scope: InstructionScope;
  discoveryOrder: number;
  contentHash?: string;
  byteLength?: number;
}

export interface InstructionDocument {
  source: InstructionSource;
  content: string;
  truncated: boolean;
  warnings: string[];
  permissionDirectives: InstructionPermissionDirective[];
}

export interface InstructionCandidate {
  uri: string;
  fileName: string;
  scope: InstructionScope;
  trust: Extract<TrustLevel, 'user' | 'repository'>;
  bytes: Uint8Array;
}

export interface InstructionAdapter {
  readonly id: string;
  readonly fileNames: readonly string[];
  supports(candidate: InstructionCandidate): boolean;
  parse(candidate: InstructionCandidate, source: InstructionSource): Promise<InstructionDocument>;
}

/**
 * 权限指令。effect 只能是 deny 或 request_approval——刻意不含 allow。
 * 规则文件不可信：指令只能收紧权限或申请审批，不能放宽或新增权限；
 * 解析端必须拒绝任何非以上两种的效果。
 */
export interface InstructionPermissionDirective {
  id: string;
  sourceId: string;
  sourceTrust: Extract<TrustLevel, 'user' | 'repository'>;
  effect: 'deny' | 'request_approval';
  permission: Permission;
  reason: string;
}

export interface InstructionPermissionEvaluation {
  effectivePermissions: Permission[];
  deniedPermissions: Permission[];
  approvalRequests: Array<{
    permission: Permission;
    sourceIds: string[];
    reasons: string[];
  }>;
  rejectedDirectiveIds: string[];
}

export interface InstructionDiscoveryPolicy {
  globalFileOrder: readonly ['AGENTS.override.md', 'AGENTS.md'];
  directoryFileOrder: readonly ['AGENTS.override.md', 'AGENTS.md', 'configured_fallbacks'];
  mergeDirection: 'global_then_root_to_target';
  maxCombinedBytes: number;
  oneFilePerDirectory: true;
}

export const DEFAULT_INSTRUCTION_DISCOVERY_POLICY: InstructionDiscoveryPolicy = {
  globalFileOrder: ['AGENTS.override.md', 'AGENTS.md'],
  directoryFileOrder: ['AGENTS.override.md', 'AGENTS.md', 'configured_fallbacks'],
  mergeDirection: 'global_then_root_to_target',
  maxCombinedBytes: 32 * 1024,
  oneFilePerDirectory: true,
};

// 规则优先级：deny 最高且不可被后续申请恢复；request_approval 只能对运行时
// 已授权的权限生效，不能新增权限；超出运行时权限上限的申请被拒绝（fail-closed），
// 未知或非法效果同样被拒绝，保证规则只能收紧、永远无法放宽。
export function evaluateInstructionPermissions(
  runtimeGranted: ReadonlySet<Permission>,
  directives: readonly InstructionPermissionDirective[],
): InstructionPermissionEvaluation {
  const effective = new Set(runtimeGranted);
  const denied = new Set<Permission>();
  const requests = new Map<Permission, { sourceIds: Set<string>; reasons: Set<string> }>();
  const rejectedDirectiveIds: string[] = [];

  for (const directive of directives) {
    if (directive.effect === 'deny') {
      denied.add(directive.permission);
      effective.delete(directive.permission);
      continue;
    }
    if (directive.effect !== 'request_approval') {
      rejectedDirectiveIds.push(directive.id);
      continue;
    }
    if (denied.has(directive.permission)) continue;
    if (!runtimeGranted.has(directive.permission)) {
      rejectedDirectiveIds.push(directive.id);
      continue;
    }
    effective.delete(directive.permission);
    const request = requests.get(directive.permission) ?? {
      sourceIds: new Set<string>(),
      reasons: new Set<string>(),
    };
    request.sourceIds.add(directive.sourceId);
    request.reasons.add(directive.reason);
    requests.set(directive.permission, request);
  }

  for (const permission of denied) effective.delete(permission);
  return {
    effectivePermissions: [...effective].sort(),
    deniedPermissions: [...denied].sort(),
    approvalRequests: [...requests.entries()]
      .filter(([permission]) => !denied.has(permission))
      .map(([permission, request]) => ({
        permission,
        sourceIds: [...request.sourceIds].sort(),
        reasons: [...request.reasons].sort(),
      }))
      .sort((left, right) => left.permission.localeCompare(right.permission)),
    rejectedDirectiveIds: rejectedDirectiveIds.sort(),
  };
}
