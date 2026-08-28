import {
  Client,
  StreamableHTTPClientTransport,
  type CallToolResult,
  type GetPromptResult,
  type Progress,
  type ReadResourceResult,
  type Tool,
  type Transport,
  type VersionNegotiationMode,
} from '@modelcontextprotocol/client';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/client/stdio';
import { PathPolicy } from '../runtime/path-policy.js';
import type { McpProgressEvent, McpServerCatalog, McpServerConfig } from './types.js';

interface ConnectedServer {
  config: McpServerConfig;
  client: Client;
  catalog: McpServerCatalog;
}

export interface McpClientManagerOptions {
  transportFactory?: (config: McpServerConfig) => Promise<Transport> | Transport;
  onProgress?: (event: McpProgressEvent) => void;
}

export class McpClientError extends Error {
  constructor(
    readonly code: 'mcp_config_invalid' | 'mcp_connection_failed' | 'mcp_request_failed',
    message: string,
  ) {
    super(message);
    this.name = 'McpClientError';
  }
}

export class McpClientManager {
  private readonly connections = new Map<string, ConnectedServer>();

  constructor(
    private readonly workspaceRoot: string,
    private readonly options: McpClientManagerOptions = {},
  ) {}

  async connectAll(configs: readonly McpServerConfig[], signal?: AbortSignal): Promise<McpServerCatalog[]> {
    const connected: McpServerCatalog[] = [];
    for (const config of configs.filter((item) => item.enabled)) {
      connected.push(await this.connect(config, signal));
    }
    return connected;
  }

  async connect(config: McpServerConfig, signal?: AbortSignal): Promise<McpServerCatalog> {
    if (this.connections.has(config.id)) throw new McpClientError('mcp_config_invalid', `MCP Server 已连接：${config.id}`);
    const client = new Client(
      { name: 'echolens-agent', version: '0.5.0' },
      {
        capabilities: {},
        enforceStrictCapabilities: true,
        listMaxPages: 16,
        inputRequired: { autoFulfill: false },
        versionNegotiation: { mode: protocolMode(config.protocolMode) },
      },
    );
    const transport = await this.createTransport(config);
    try {
      await client.connect(transport, { signal, timeout: config.timeoutMs ?? 30_000 });
      const [toolsResult, resourcesResult, promptsResult] = await Promise.all([
        client.listTools(undefined, requestOptions(config, signal)),
        client.listResources(undefined, requestOptions(config, signal)),
        client.listPrompts(undefined, requestOptions(config, signal)),
      ]);
      enforceCatalogLimits(config.id, toolsResult.tools.length, resourcesResult.resources.length, promptsResult.prompts.length);
      const allowedTools = config.permissions?.tools ? new Set(config.permissions.tools) : undefined;
      const serverVersion = client.getServerVersion();
      const catalog: McpServerCatalog = {
        serverId: config.id,
        trust: config.trust,
        autoApproveReadOnly: config.trust === 'trusted' && config.permissions?.autoApproveReadOnly === true,
        protocolVersion: client.getNegotiatedProtocolVersion(),
        protocolEra: client.getProtocolEra(),
        serverName: serverVersion ? `${serverVersion.name}@${serverVersion.version}` : undefined,
        tools: structuredClone(toolsResult.tools.filter((tool) => !allowedTools || allowedTools.has(tool.name))),
        resources: config.permissions?.resources === false ? [] : structuredClone(resourcesResult.resources),
        prompts: config.permissions?.prompts === false ? [] : structuredClone(promptsResult.prompts),
      };
      this.connections.set(config.id, { config: structuredClone(config), client, catalog });
      return structuredClone(catalog);
    } catch (error) {
      await client.close().catch(() => undefined);
      if (error instanceof McpClientError) throw error;
      throw new McpClientError('mcp_connection_failed', `MCP Server 连接或能力发现失败：${config.id}`);
    }
  }

  catalogs(): McpServerCatalog[] {
    return [...this.connections.values()].map((item) => structuredClone(item.catalog));
  }

  toolDefinition(serverId: string, name: string): Tool | undefined {
    return structuredClone(this.connection(serverId).catalog.tools.find((tool) => tool.name === name));
  }

  async callTool(
    serverId: string,
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
    onProgress?: (progress: Progress) => void,
  ): Promise<CallToolResult> {
    const connection = this.connection(serverId);
    const definition = connection.catalog.tools.find((tool) => tool.name === name);
    if (!definition) throw new McpClientError('mcp_request_failed', `MCP 工具不存在：${serverId}/${name}`);
    try {
      return await connection.client.callTool(
        { name, arguments: structuredClone(args) },
        {
          ...requestOptions(connection.config, signal),
          toolDefinition: definition,
          onprogress: (progress) => {
            onProgress?.(progress);
            this.options.onProgress?.({ serverId, operation: `tool:${name}`, progress });
          },
          resetTimeoutOnProgress: true,
        },
      );
    } catch {
      throw new McpClientError('mcp_request_failed', `MCP 工具调用失败：${serverId}/${name}`);
    }
  }

  async readResource(serverId: string, uri: string, signal?: AbortSignal): Promise<ReadResourceResult> {
    const connection = this.connection(serverId);
    try {
      return await connection.client.readResource({ uri }, requestOptions(connection.config, signal));
    } catch {
      throw new McpClientError('mcp_request_failed', `MCP Resource 读取失败：${serverId}`);
    }
  }

  async getPrompt(
    serverId: string,
    name: string,
    args: Record<string, string> | undefined,
    signal?: AbortSignal,
  ): Promise<GetPromptResult> {
    const connection = this.connection(serverId);
    try {
      return await connection.client.getPrompt({ name, arguments: args }, requestOptions(connection.config, signal));
    } catch {
      throw new McpClientError('mcp_request_failed', `MCP Prompt 获取失败：${serverId}/${name}`);
    }
  }

  async close(): Promise<void> {
    const connections = [...this.connections.values()];
    this.connections.clear();
    await Promise.all(connections.map((item) => item.client.close().catch(() => undefined)));
  }

  private connection(serverId: string): ConnectedServer {
    const connection = this.connections.get(serverId);
    if (!connection) throw new McpClientError('mcp_request_failed', `MCP Server 未连接：${serverId}`);
    return connection;
  }

  private async createTransport(config: McpServerConfig): Promise<Transport> {
    if (this.options.transportFactory) return this.options.transportFactory(config);
    if (config.transport.type === 'streamable_http') {
      return new StreamableHTTPClientTransport(new URL(config.transport.url), {
        requestInit: { headers: resolveEnvironmentMap(config.transport.headersFrom) },
        onInsufficientScope: 'throw',
      });
    }
    if (!/^[A-Za-z0-9._+-]{1,128}$/u.test(config.transport.command)) {
      throw new McpClientError('mcp_config_invalid', `MCP stdio command 必须是简单可执行文件名：${config.id}`);
    }
    const cwd = config.transport.cwd ?? '.';
    const policy = await PathPolicy.create(this.workspaceRoot);
    const resolvedCwd = await policy.resolveExisting(cwd, 'directory');
    return new StdioClientTransport({
      command: config.transport.command,
      args: config.transport.args,
      cwd: resolvedCwd.canonicalPath,
      stderr: 'pipe',
      maxBufferSize: 4 * 1024 * 1024,
      env: {
        ...getDefaultEnvironment(),
        ...config.transport.env,
        ...resolveEnvironmentMap(config.transport.envFrom),
      },
    });
  }
}

function requestOptions(config: McpServerConfig, signal?: AbortSignal) {
  const timeout = config.timeoutMs ?? 60_000;
  return { signal, timeout, maxTotalTimeout: timeout };
}

function protocolMode(mode: McpServerConfig['protocolMode']): VersionNegotiationMode {
  if (mode === '2026-07-28') return { pin: mode };
  return mode ?? 'auto';
}

function resolveEnvironmentMap(mapping: Record<string, string> | undefined): Record<string, string> {
  const resolved: Record<string, string> = {};
  for (const [target, source] of Object.entries(mapping ?? {})) {
    const value = process.env[source];
    if (value === undefined) throw new McpClientError('mcp_config_invalid', `MCP 引用的环境变量未配置：${source}`);
    resolved[target] = value;
  }
  return resolved;
}

function enforceCatalogLimits(serverId: string, tools: number, resources: number, prompts: number): void {
  if (tools > 128 || resources > 256 || prompts > 128) {
    throw new McpClientError('mcp_connection_failed', `MCP 能力目录超过上限：${serverId}`);
  }
}
