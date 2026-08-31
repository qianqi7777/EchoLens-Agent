import type {
  ToolError,
  ToolExecutionStatus,
  ToolOutputMetadata,
} from '../core/messages.js';
import type { Permission } from '../core/permissions.js';
export type { Permission } from '../core/permissions.js';

/**
 * Agent Runtime 的共享类型。
 *
 * 这些类型刻意不绑定 LangChain、LangGraph 或某个模型厂商，方便后续替换
 * 模型 SDK，同时保证工具执行、事件记录和终端 UI 使用同一套数据契约。
 */

export type JsonSchemaPrimitive = string | number | boolean | null;
export type JsonSchemaTypeName = 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'null';

export interface JsonSchemaNode {
  type?: JsonSchemaTypeName | JsonSchemaTypeName[];
  description?: string;
  enum?: JsonSchemaPrimitive[];
  const?: JsonSchemaPrimitive;
  format?: string;
  pattern?: string;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
  minItems?: number;
  maxItems?: number;
  uniqueItems?: boolean;
  items?: JsonSchemaNode;
  properties?: Record<string, JsonSchemaNode>;
  required?: string[];
  additionalProperties?: boolean | JsonSchemaNode;
}

/**
 * 顶层对象 Schema。
 *
 * `additionalProperties` 必填：即使不放开额外属性也必须显式声明 `false`，
 * 避免校验器默认放行未知字段，导致工具入参超出预期。
 */
export interface JsonSchema extends JsonSchemaNode {
  type: 'object';
  properties?: Record<string, JsonSchemaNode>;
  additionalProperties: boolean | JsonSchemaNode;
}

export interface ToolSpec {
  name: string;
  description: string;
  permission: Permission;
  effect?: 'read' | 'write' | 'process' | 'network' | 'external';
  observation?: {
    type: 'workspace.file';
    operation: 'read' | 'search' | 'list';
  };
  inputSchema: JsonSchema;
  execute: (args: Record<string, unknown>, context: ToolContext) => Promise<ToolResult>;
}

/**
 * 工具执行上下文。
 *
 * `allowedPermissions` 是本次运行实际被授予的权限集合；`approvalRequiredPermissions`
 * 中的权限一旦被工具用到，必须已经过审批，工具自身不能绕过。`signal` 用于取消。
 */
export interface ToolContext {
  workspaceRoot: string;
  allowedPermissions: ReadonlySet<Permission>;
  approvalRequiredPermissions?: ReadonlySet<Permission>;
  approvalContext?: {
    sessionId?: string;
    runId?: string;
    callId?: string;
    workspaceRevision?: string;
  };
  reportProgress?: (progress: { value: number; total?: number }) => void;
  signal: AbortSignal;
}

interface ToolResultBase {
  content: string;
  summary: string;
  data?: unknown;
  outputMetadata?: ToolOutputMetadata;
  evidenceIds: string[];
}

export interface ToolSuccessResult extends ToolResultBase {
  status: 'ok';
  error?: never;
}

export interface ToolFailureResult extends ToolResultBase {
  status: Exclude<ToolExecutionStatus, 'ok'>;
  error: ToolError;
}

export type ToolResult = ToolSuccessResult | ToolFailureResult;

export interface AgentTraceItem {
  type: 'model' | 'tool' | 'warning';
  message: string;
}
