import type { Progress, Tool } from '@modelcontextprotocol/client';

export type McpTrustLevel = 'untrusted' | 'trusted';
/** 协议协商模式：'2026-07-28' 是固定到该 MCP 协议版本的 pin 值，legacy / auto 交给 SDK 协商。 */
export type McpProtocolMode = 'legacy' | 'auto' | '2026-07-28';

export interface McpStdioTransportConfig {
  type: 'stdio';
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  envFrom?: Record<string, string>;
}

export interface McpHttpTransportConfig {
  type: 'streamable_http';
  url: string;
  headersFrom?: Record<string, string>;
}

export interface McpServerConfig {
  id: string;
  enabled: boolean;
  /** trusted 只放宽「标记为只读的工具」的自动审批（需同时开启 autoApproveReadOnly），不改变其他权限门槛。 */
  trust: McpTrustLevel;
  protocolMode?: McpProtocolMode;
  timeoutMs?: number;
  permissions?: {
    tools?: string[];
    resources?: boolean;
    prompts?: boolean;
    autoApproveReadOnly?: boolean;
  };
  transport: McpStdioTransportConfig | McpHttpTransportConfig;
}

export interface McpConfigFile {
  version: 1;
  servers: McpServerConfig[];
}

export interface McpServerCatalog {
  serverId: string;
  trust: McpTrustLevel;
  autoApproveReadOnly: boolean;
  protocolVersion?: string;
  protocolEra?: 'legacy' | 'modern';
  serverName?: string;
  tools: Tool[];
  resources: Array<{ uri: string; name?: string; description?: string; mimeType?: string }>;
  prompts: Array<{ name: string; description?: string; arguments?: Array<{ name: string; required?: boolean }> }>;
}

export interface McpProgressEvent {
  serverId: string;
  operation: string;
  progress: Progress;
}
