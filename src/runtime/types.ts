/**
 * Agent Runtime 的共享类型。
 *
 * 这些类型刻意不绑定 LangChain、LangGraph 或某个模型厂商，方便后续替换
 * 模型 SDK，同时保证工具执行、事件记录和终端 UI 使用同一套数据契约。
 */

export type Permission =
  | 'workspace.read'
  | 'workspace.write'
  | 'process.exec'
  | 'network.request';

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  toolCallId?: string;
  toolName?: string;
  toolCalls?: ToolCall[];
}

export interface JsonSchema {
  type: 'object';
  properties?: Record<string, { type: string; description?: string }>;
  required?: string[];
  additionalProperties?: boolean;
}

export interface ToolSpec {
  name: string;
  description: string;
  permission: Permission;
  inputSchema: JsonSchema;
  execute: (args: Record<string, unknown>, context: ToolContext) => Promise<ToolResult>;
}

export interface ToolContext {
  workspaceRoot: string;
  allowedPermissions: ReadonlySet<Permission>;
  signal: AbortSignal;
}

export interface ToolResult {
  status: 'ok' | 'error' | 'denied' | 'timeout';
  content: string;
  summary: string;
  evidenceIds: string[];
}

export interface ModelToolDefinition {
  name: string;
  description: string;
  parameters: JsonSchema;
}

export interface ModelRequest {
  messages: ChatMessage[];
  tools?: ModelToolDefinition[];
  signal?: AbortSignal;
}

export interface ModelResponse {
  text: string;
  toolCalls: ToolCall[];
}

export interface ChatModel {
  readonly model: string;
  complete(request: ModelRequest): Promise<ModelResponse>;
}

export interface AgentTraceItem {
  type: 'model' | 'tool' | 'warning';
  message: string;
}

