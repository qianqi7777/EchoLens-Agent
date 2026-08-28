import { lstat, readFile, realpath } from 'node:fs/promises';
import * as path from 'node:path';
import Ajv from 'ajv';
import { validateRelativePath } from '../runtime/path-policy.js';
import type { McpConfigFile, McpServerConfig } from './types.js';

const MAX_CONFIG_BYTES = 256 * 1024;
const ENV_NAME = '^[A-Za-z_][A-Za-z0-9_]{0,127}$';
const configSchema = {
  type: 'object',
  required: ['version', 'servers'],
  additionalProperties: false,
  properties: {
    version: { const: 1 },
    servers: {
      type: 'array', maxItems: 16,
      items: {
        type: 'object',
        required: ['id', 'enabled', 'trust', 'transport'],
        additionalProperties: false,
        properties: {
          id: { type: 'string', pattern: '^[a-z0-9][a-z0-9_-]{0,31}$' },
          enabled: { type: 'boolean' },
          trust: { enum: ['untrusted', 'trusted'] },
          protocolMode: { enum: ['legacy', 'auto', '2026-07-28'] },
          timeoutMs: { type: 'integer', minimum: 1_000, maximum: 300_000 },
          permissions: {
            type: 'object', additionalProperties: false,
            properties: {
              tools: { type: 'array', maxItems: 128, uniqueItems: true, items: { type: 'string', minLength: 1, maxLength: 128 } },
              resources: { type: 'boolean' },
              prompts: { type: 'boolean' },
              autoApproveReadOnly: { type: 'boolean' },
            },
          },
          transport: {
            oneOf: [
              {
                type: 'object', required: ['type', 'command'], additionalProperties: false,
                properties: {
                  type: { const: 'stdio' },
                  command: { type: 'string', minLength: 1, maxLength: 4096 },
                  args: { type: 'array', maxItems: 128, items: { type: 'string', maxLength: 8192, pattern: '^[^\\u0000\\r\\n]*$' } },
                  cwd: { type: 'string', minLength: 1, maxLength: 4096 },
                  env: { type: 'object', maxProperties: 32, propertyNames: { pattern: ENV_NAME }, additionalProperties: { type: 'string', maxLength: 8192 } },
                  envFrom: { type: 'object', maxProperties: 32, propertyNames: { pattern: ENV_NAME }, additionalProperties: { type: 'string', pattern: ENV_NAME } },
                },
              },
              {
                type: 'object', required: ['type', 'url'], additionalProperties: false,
                properties: {
                  type: { const: 'streamable_http' },
                  url: { type: 'string', minLength: 1, maxLength: 4096 },
                  headersFrom: { type: 'object', maxProperties: 16, propertyNames: { pattern: '^[A-Za-z0-9-]{1,64}$' }, additionalProperties: { type: 'string', pattern: ENV_NAME } },
                },
              },
            ],
          },
        },
      },
    },
  },
} as const;

const validateConfig = new Ajv({ allErrors: true, strict: true }).compile(configSchema);

export class McpConfigError extends Error {
  constructor(readonly code: 'mcp_config_invalid' | 'mcp_config_secret' | 'mcp_config_path', message: string) {
    super(message);
    this.name = 'McpConfigError';
  }
}

export async function loadMcpConfig(
  workspaceRoot: string,
  relativePath = process.env.AGENT_MCP_CONFIG?.trim() || '.echolens/mcp.json',
): Promise<McpConfigFile> {
  let source: Buffer;
  try {
    validateRelativePath(relativePath);
    const canonicalRoot = await realpath(workspaceRoot);
    const requested = path.resolve(canonicalRoot, relativePath);
    assertInside(canonicalRoot, requested);
    const requestedStat = await lstat(requested);
    if (requestedStat.isSymbolicLink() || !requestedStat.isFile() || requestedStat.size > MAX_CONFIG_BYTES) {
      throw new McpConfigError('mcp_config_path', 'MCP 配置必须是工作区内的普通小文件');
    }
    const canonicalFile = await realpath(requested);
    assertInside(canonicalRoot, canonicalFile);
    source = await readFile(canonicalFile);
  } catch (error) {
    if (isNotFound(error)) return { version: 1, servers: [] };
    if (error instanceof McpConfigError) throw error;
    throw new McpConfigError('mcp_config_path', 'MCP 配置必须位于当前工作区内');
  }
  let value: unknown;
  try { value = JSON.parse(source.toString('utf8')); }
  catch { throw new McpConfigError('mcp_config_invalid', 'MCP 配置不是有效 JSON'); }
  if (!validateConfig(value)) {
    const issue = validateConfig.errors?.[0];
    throw new McpConfigError('mcp_config_invalid', `MCP 配置不符合 Schema：${issue?.instancePath || '/'} ${issue?.message || ''}`.trim());
  }
  const config = structuredClone(value) as McpConfigFile;
  const ids = new Set<string>();
  for (const server of config.servers) {
    if (ids.has(server.id)) throw new McpConfigError('mcp_config_invalid', `MCP Server ID 重复：${server.id}`);
    ids.add(server.id);
    validateServerSecrets(server);
    validateTransportUrl(server);
  }
  return config;
}

function validateServerSecrets(server: McpServerConfig): void {
  if (server.transport.type !== 'stdio') return;
  for (const name of Object.keys(server.transport.env ?? {})) {
    if (/(?:key|token|secret|password|credential|authorization)/iu.test(name)) {
      throw new McpConfigError('mcp_config_secret', `MCP 敏感环境变量必须通过 envFrom 引用：${name}`);
    }
  }
}

function validateTransportUrl(server: McpServerConfig): void {
  if (server.transport.type !== 'streamable_http') return;
  let url: URL;
  try { url = new URL(server.transport.url); }
  catch { throw new McpConfigError('mcp_config_invalid', `MCP URL 无效：${server.id}`); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new McpConfigError('mcp_config_invalid', `MCP HTTP Server 必须使用 HTTPS：${server.id}`);
  }
  if (url.username || url.password) throw new McpConfigError('mcp_config_secret', `MCP URL 不得内嵌凭据：${server.id}`);
}

function assertInside(root: string, candidate: string): void {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new McpConfigError('mcp_config_path', 'MCP 配置路径越界');
  }
}

function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}
