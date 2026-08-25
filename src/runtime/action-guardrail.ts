import * as path from 'node:path';
import type { ToolSpec, ToolContext } from './types.js';
import { PathPolicy, PathPolicyError } from './path-policy.js';

export type ToolEffect = 'read' | 'write' | 'process' | 'network' | 'external';
export type GuardrailDecisionKind = 'allow' | 'deny' | 'redact' | 'require_approval';

export interface ProposedActionDecision {
  decision: GuardrailDecisionKind;
  reasonCode: string;
  reason: string;
  normalizedArguments: Record<string, unknown>;
}

export interface ProposedActionGuardrail {
  evaluate(
    tool: ToolSpec,
    args: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ProposedActionDecision>;
}

export class DefaultProposedActionGuardrail implements ProposedActionGuardrail {
  private readonly policies = new Map<string, Promise<PathPolicy>>();

  async evaluate(
    tool: ToolSpec,
    args: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ProposedActionDecision> {
    if (context.approvalRequiredPermissions?.has(tool.permission)) {
      return outcome(
        'require_approval',
        'instruction_approval_required',
        `项目规则要求审批 ${tool.permission}`,
        args,
      );
    }
    if (!context.allowedPermissions.has(tool.permission)) {
      return outcome('deny', 'permission_denied', `Runtime 未授予 ${tool.permission}`, args);
    }
    if (hasDangerousObjectKey(args)) {
      return outcome('deny', 'dangerous_argument_key', '工具参数包含危险对象键', args);
    }
    const effect = tool.effect ?? effectForPermission(tool.permission);
    if (effect !== 'read') {
      return outcome(
        'require_approval',
        'approval_required',
        `${effect} 类工具需要显式审批`,
        args,
      );
    }

    const hasPathParameter = Boolean(tool.inputSchema.properties?.path);
    const requestedPath = args.path ?? (hasPathParameter ? '.' : undefined);
    if (typeof requestedPath !== 'string') {
      return outcome('allow', 'read_action_allowed', '只读工具通过动作检查', args);
    }
    try {
      const policy = await this.policyFor(context.workspaceRoot);
      const resolved = await policy.resolveExisting(requestedPath);
      const normalizedPath = path.relative(policy.workspaceRoot, resolved.canonicalPath) || '.';
      return outcome('allow', 'workspace_path_verified', '只读路径已限制在工作区内', {
        ...args,
        path: normalizedPath,
      });
    } catch (error) {
      const reasonCode = error instanceof PathPolicyError ? error.code : 'path_guardrail_failed';
      return outcome('deny', reasonCode, '工具路径未通过动作检查', args);
    }
  }

  private policyFor(workspaceRoot: string): Promise<PathPolicy> {
    const key = process.platform === 'win32'
      ? path.resolve(workspaceRoot).toLowerCase()
      : path.resolve(workspaceRoot);
    const current = this.policies.get(key);
    if (current) return current;
    const created = PathPolicy.create(workspaceRoot);
    this.policies.set(key, created);
    void created.catch(() => this.policies.delete(key));
    return created;
  }
}

function outcome(
  decision: GuardrailDecisionKind,
  reasonCode: string,
  reason: string,
  normalizedArguments: Record<string, unknown>,
): ProposedActionDecision {
  return { decision, reasonCode, reason, normalizedArguments: structuredClone(normalizedArguments) };
}

function effectForPermission(permission: ToolSpec['permission']): ToolEffect {
  if (permission === 'workspace.read') return 'read';
  if (permission === 'workspace.write') return 'write';
  if (permission === 'process.exec') return 'process';
  return 'network';
}

function hasDangerousObjectKey(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some(hasDangerousObjectKey);
  for (const [key, child] of Object.entries(value)) {
    if (key === '__proto__' || key === 'prototype' || key === 'constructor') return true;
    if (hasDangerousObjectKey(child)) return true;
  }
  return false;
}
