import {
  Client,
  SUPPORTED_PROTOCOL_VERSIONS,
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

/**
 * MCP Server 外部进程 / HTTP 连接的生命周期管理者。
 *
 * 对外读取（catalogs()、toolDefinition()、connect() 返回值）均为快照副本，
 * 调用方无法持有对内部连接或能力目录的引用。
 */
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
    const mode = protocolMode(config.protocolMode);
    // 客户端按 fail-closed 配置：严格能力校验 + input_required 不自动完成，
    // 防止不可信服务器声明未实现的能力或驱动连续回填的请求链。
    const client = new Client(
      { name: 'echolens-agent', version: '0.5.0' },
      {
        capabilities: {},
        enforceStrictCapabilities: true,
        listMaxPages: 16,
        inputRequired: { autoFulfill: false },
        versionNegotiation: { mode },
        supportedProtocolVersions: supportedProtocolVersions(mode),
      },
    );
    const transport = await this.createTransport(config);
    try {
      await client.connect(transport, { signal, timeout: config.timeoutMs ?? 30_000 });
      const capabilities = client.getServerCapabilities() ?? {};
      const [toolsResult, resourcesResult, promptsResult] = await Promise.all([
        capabilities.tools
          ? client.listTools(undefined, requestOptions(config, signal))
          : Promise.resolve({ tools: [] }),
        capabilities.resources && config.permissions?.resources !== false
          ? client.listResources(undefined, requestOptions(config, signal))
          : Promise.resolve({ resources: [] }),
        capabilities.prompts && config.permissions?.prompts !== false
          ? client.listPrompts(undefined, requestOptions(config, signal))
          : Promise.resolve({ prompts: [] }),
      ]);
      enforceCatalogLimits(config.id, toolsResult.tools.length, resourcesResult.resources.length, promptsResult.prompts.length);
      // 信任边界：autoApproveReadOnly 仅对 trust=trusted 的服务器生效，不可信服务器
      // 永远不会获得自动审批；permissions.tools 作为白名单在目录构建期过滤，
      // 未列出的工具不会暴露给模型。
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
        resources: structuredClone(resourcesResult.resources),
        prompts: structuredClone(promptsResult.prompts),
      };
      this.connections.set(config.id, { config: structuredClone(config), client, catalog });
      return structuredClone(catalog);
    } catch (error) {
      // 失败策略：连接或能力发现失败时先关闭客户端（释放子进程 / HTTP 传输），
      // 避免残留孤儿进程，再统一转成 mcp_connection_failed 类型错误。
      await client.close().catch(() => undefined);
      if (error instanceof McpClientError) throw error;
      throw new McpClientError(
        'mcp_connection_failed',
        `MCP Server 连接或能力发现失败：${config.id}（${safeErrorCategory(error)}）`,
      );
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
      // 参数先克隆再发送，避免调用方在途修改共享对象；请求携带 AbortSignal，
      // resetTimeoutOnProgress 使持续上报进度的长任务不被空闲超时中断。
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
      const url = validatedHttpUrl(config.id, config.transport.url);
      return new StreamableHTTPClientTransport(url, {
        requestInit: { headers: resolveEnvironmentMap(config.transport.headersFrom) },
        onInsufficientScope: 'throw',
      });
    }
    // command 只允许裸可执行文件名（无路径分隔符与 shell 元字符），args 原样
    // 传给 spawn 而非 shell，保证子进程派生路径无注入面。
    if (!/^[A-Za-z0-9._+-]{1,128}$/u.test(config.transport.command)) {
      throw new McpClientError('mcp_config_invalid', `MCP stdio command 必须是简单可执行文件名：${config.id}`);
    }
    // 子进程 cwd 经 PathPolicy 解析并规范化：必须落在工作区内且不含链接组件；
    // stderr 用 pipe 捕获而不继承终端，消息读取缓冲上限 4 MiB，防止子进程输出耗尽内存。
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

// Streamable HTTP 仅允许 HTTPS，http 仅限回环地址；URL 内嵌凭据一律拒绝，
// 防止把配置用于请求任意明文端点或在传输中泄露账密。
function validatedHttpUrl(serverId: string, value: string): URL {
  let url: URL;
  try { url = new URL(value); }
  catch { throw new McpClientError('mcp_config_invalid', `MCP URL 无效：${serverId}`); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new McpClientError('mcp_config_invalid', `MCP HTTP Server 必须使用 HTTPS：${serverId}`);
  }
  if (url.username || url.password) {
    throw new McpClientError('mcp_config_invalid', `MCP URL 不得内嵌凭据：${serverId}`);
  }
  return url;
}

function requestOptions(config: McpServerConfig, signal?: AbortSignal) {
  const timeout = config.timeoutMs ?? 60_000;
  return { signal, timeout, maxTotalTimeout: timeout };
}

// MCP 协议版本协商：legacy 让 SDK 在默认版本列表内兼容协商，'2026-07-28' 固定到该版本。
function protocolMode(mode: McpServerConfig['protocolMode']): VersionNegotiationMode {
  if (mode === '2026-07-28') return { pin: mode };
  return mode ?? 'auto';
}

// 固定版本模式的候选列表以目标版本优先；legacy 直接复用 SDK 默认协商。
function supportedProtocolVersions(mode: VersionNegotiationMode): string[] | undefined {
  if (mode === 'legacy') return undefined;
  const modern = typeof mode === 'object' ? mode.pin : '2026-07-28';
  return [...new Set([modern, ...SUPPORTED_PROTOCOL_VERSIONS])];
}

function resolveEnvironmentMap(mapping: Record<string, string> | undefined): Record<string, string> {
  const resolved: Record<string, string> = {};
  for (const [target, source] of Object.entries(mapping ?? {})) {
    // fail-closed：引用的环境变量缺失时拒绝启动，避免把空值静默注入子进程环境。
    const value = process.env[source];
    if (value === undefined) throw new McpClientError('mcp_config_invalid', `MCP 引用的环境变量未配置：${source}`);
    resolved[target] = value;
  }
  return resolved;
}

// 目录规模上限：防止不可信或故障服务器返回海量能力，导致内存与模型上下文耗尽。
function enforceCatalogLimits(serverId: string, tools: number, resources: number, prompts: number): void {
  if (tools > 128 || resources > 256 || prompts > 128) {
    throw new McpClientError('mcp_connection_failed', `MCP 能力目录超过上限：${serverId}`);
  }
}

function safeErrorCategory(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = String(error.code).replace(/[^A-Za-z0-9_.-]/gu, '').slice(0, 64);
    if (code) return `sdk:${code}`;
  }
  if (error instanceof Error) return error.name.replace(/[^A-Za-z0-9_.-]/gu, '').slice(0, 64) || 'Error';
  return 'unknown';
}
