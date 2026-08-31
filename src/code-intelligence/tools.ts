import type { JsonSchema, JsonSchemaNode, ToolContext, ToolResult } from '../runtime/types.js';
import { ToolRegistry } from '../runtime/tool-registry.js';
import { toolFailure, toolSuccess } from '../runtime/tool-result.js';
import type { CodeDiagnostic, CodeLocation, CodeSymbol } from './types.js';
import { CodeIntelligenceError } from './types.js';
import { CodeIntelligenceService, type CodeIntelligenceResult } from './code-intelligence-service.js';

const pathProperty: JsonSchemaNode = { type: 'string', minLength: 1, maxLength: 4096 };
export const CODE_INTELLIGENCE_TOOL_NAMES = [
  'outline_file',
  'find_symbols',
  'go_to_definition',
  'find_references',
  'get_diagnostics',
] as const;

const positionProperties: Record<string, JsonSchemaNode> = {
  path: pathProperty,
  line: { type: 'integer', minimum: 1, maximum: 1_000_000 },
  column: { type: 'integer', minimum: 1, maximum: 1_000_000 },
};

/**
 * 注册五个只读代码定位工具：outline_file / find_symbols / go_to_definition /
 * find_references / get_diagnostics。
 *
 * 全部为 workspace.read 权限、effect: read，无副作用也不触发审批。
 * 工具输出只是不可信证据回填，不得进入 System Policy 或改变权限集合。
 */
export function registerCodeIntelligenceTools(
  registry: ToolRegistry,
  service: CodeIntelligenceService,
): void {
  registry.register({
    name: 'outline_file',
    description: '使用 tree-sitter 返回源码文件中的函数、类、类型和成员定义。',
    permission: 'workspace.read',
    effect: 'read',
    observation: { type: 'workspace.file', operation: 'read' },
    inputSchema: schema({ path: pathProperty }, ['path']),
    execute: (args) => run(() => service.outlineFile(String(args.path)), formatSymbols, '读取文件符号失败'),
  });
  registry.register({
    name: 'find_symbols',
    description: '使用 tree-sitter 在工作区中按名称搜索函数、类、类型和成员定义。',
    permission: 'workspace.read',
    effect: 'read',
    observation: { type: 'workspace.file', operation: 'search' },
    inputSchema: schema({
      query: { type: 'string', minLength: 1, maxLength: 512 },
      path: pathProperty,
    }, ['query']),
    execute: (args) => run(
      () => service.findSymbols(String(args.query), typeof args.path === 'string' ? args.path : '.'),
      formatSymbols,
      '搜索工作区符号失败',
    ),
  });
  registry.register({
    name: 'go_to_definition',
    description: '使用 TypeScript LSP 查找定义；LSP 不可用时自动降级到 tree-sitter。',
    permission: 'workspace.read',
    effect: 'read',
    observation: { type: 'workspace.file', operation: 'search' },
    inputSchema: schema(positionProperties, ['path', 'line', 'column']),
    execute: (args, context) => run(
      () => service.goToDefinition(String(args.path), Number(args.line), Number(args.column), context.signal),
      formatLocations,
      '查找定义失败',
    ),
  });
  registry.register({
    name: 'find_references',
    description: '使用 TypeScript LSP 查找引用；LSP 不可用时自动降级到 tree-sitter 名称引用。',
    permission: 'workspace.read',
    effect: 'read',
    observation: { type: 'workspace.file', operation: 'search' },
    inputSchema: schema(positionProperties, ['path', 'line', 'column']),
    execute: (args, context) => run(
      () => service.findReferences(String(args.path), Number(args.line), Number(args.column), context.signal),
      formatLocations,
      '查找引用失败',
    ),
  });
  registry.register({
    name: 'get_diagnostics',
    description: '读取 TypeScript LSP 诊断；LSP 不可用时返回 tree-sitter 语法诊断。',
    permission: 'workspace.read',
    effect: 'read',
    observation: { type: 'workspace.file', operation: 'read' },
    inputSchema: schema({ path: pathProperty }, ['path']),
    execute: (args, context) => run(
      () => service.getDiagnostics(String(args.path), context.signal),
      formatDiagnostics,
      '读取诊断失败',
    ),
  });
}

async function run<T extends CodeLocation>(
  operation: () => Promise<CodeIntelligenceResult<T>>,
  format: (items: T[]) => string,
  fallbackMessage: string,
): Promise<ToolResult> {
  try {
    const result = await operation();
    // 降级发生时在文本里追加 [warning]，让模型感知结果来自降级来源而非纯净 LSP 语义结果。
    const warning = result.fallbackReason ? `\n[warning] ${result.fallbackReason}` : '';
    return toolSuccess(
      `${format(result.items) || '[info] 没有结果'}${warning}`,
      `${result.engine} 返回 ${result.items.length} 条结果`,
      evidenceIds(result.items),
      { engine: result.engine, count: result.items.length, fallbackReason: result.fallbackReason, items: result.items },
    );
  } catch (error) {
    if (error instanceof CodeIntelligenceError) {
      // code_intelligence_failed 是确定性失败（如不支持的文件类型），不可重试；
      // 其余错误（如 LSP 会话问题）标记为可重试。
      return toolFailure('failed', error.code, error.message, { retryable: error.code !== 'code_intelligence_failed' });
    }
    return toolFailure('failed', 'code_intelligence_failed', fallbackMessage);
  }
}

function formatSymbols(items: CodeSymbol[]): string {
  return items.map((item) => `${item.path}:${item.startLine}:${item.startColumn}\t${item.kind}\t${item.name}`).join('\n');
}

function formatLocations(items: CodeLocation[]): string {
  return items.map((item) => `${item.path}:${item.startLine}:${item.startColumn}-${item.endLine}:${item.endColumn}`).join('\n');
}

function formatDiagnostics(items: CodeDiagnostic[]): string {
  return items.map((item) => (
    `${item.path}:${item.startLine}:${item.startColumn}\t${item.severity}\t${item.code ? `${item.code} ` : ''}${item.message}`
  )).join('\n');
}

function evidenceIds(items: CodeLocation[]): string[] {
  return items.slice(0, 200).map((item) => (
    'evidenceId' in item && typeof item.evidenceId === 'string'
      ? item.evidenceId
      : `code:${item.path}:${item.startLine}:${item.startColumn}`
  ));
}

function schema(properties: Record<string, JsonSchemaNode>, required: string[]): JsonSchema {
  return { type: 'object', properties, required, additionalProperties: false };
}
