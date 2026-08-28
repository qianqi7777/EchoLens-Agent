import { CodeIntelligenceService, registerCodeIntelligenceTools } from '../code-intelligence/index.js';
import {
  loadMcpConfig,
  McpClientManager,
  registerMcpTools,
  type McpConfigFile,
} from '../mcp/index.js';
import { ToolRegistry } from './tool-registry.js';

export interface RuntimeExtensionsOptions {
  codeIntelligence?: CodeIntelligenceService;
  mcpManager?: McpClientManager;
  mcpConfig?: McpConfigFile;
}

export interface RuntimeExtensions {
  codeIntelligence: CodeIntelligenceService;
  mcpManager: McpClientManager;
  connectedMcpServers: string[];
  notices: string[];
  close(): Promise<void>;
}

export async function initializeRuntimeExtensions(
  registry: ToolRegistry,
  workspaceRoot: string,
  options: RuntimeExtensionsOptions = {},
): Promise<RuntimeExtensions> {
  const notices: string[] = [];
  const codeIntelligence = options.codeIntelligence ?? new CodeIntelligenceService(workspaceRoot);
  const mcpManager = options.mcpManager ?? new McpClientManager(workspaceRoot);
  registerCodeIntelligenceTools(registry, codeIntelligence);

  let config: McpConfigFile = { version: 1, servers: [] };
  try {
    config = options.mcpConfig ?? await loadMcpConfig(workspaceRoot);
  } catch (error) {
    notices.push(`MCP 配置未加载：${safeMessage(error)}`);
  }

  const enabled = config.servers.filter((server) => server.enabled);
  const results = await Promise.allSettled(enabled.map((server) => mcpManager.connect(server)));
  const connectedMcpServers: string[] = [];
  for (const [index, result] of results.entries()) {
    const serverId = enabled[index]!.id;
    if (result.status === 'fulfilled') connectedMcpServers.push(serverId);
    else notices.push(`MCP Server ${serverId} 未连接：${safeMessage(result.reason)}`);
  }
  registerMcpTools(registry, mcpManager);

  return {
    codeIntelligence,
    mcpManager,
    connectedMcpServers,
    notices,
    async close() {
      await Promise.allSettled([mcpManager.close(), codeIntelligence.close()]);
    },
  };
}

function safeMessage(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 500) : '未知错误';
}
