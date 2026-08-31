import * as path from 'node:path';
import type { JsonSchema, JsonSchemaNode, ToolContext, ToolResult } from './types.js';
import { ToolRegistry } from './tool-registry.js';
import { toolFailure, toolSuccess } from './tool-result.js';
import { PathPolicy, PathPolicyError } from './path-policy.js';
import { applyPatch, PatchError, saveEditCheckpoint } from './structured-patch.js';

const sourceExtensions = new Set([
  '.py', '.ts', '.tsx', '.js', '.jsx', '.go', '.rs', '.java', '.kt', '.cs', '.cpp', '.h',
]);
const ignoredDirectories = new Set([
  '.git', '.echolens', 'node_modules', '.venv', 'dist', 'build', '.echolens_index',
]);
const pathProperty: JsonSchemaNode = { type: 'string', minLength: 1, maxLength: 4096 };
const pathPolicies = new Map<string, Promise<PathPolicy>>();

interface ReadFileArguments {
  path: string;
  start?: number;
  end?: number;
}

interface GrepArguments {
  pattern: string;
  path?: string;
}

interface ListFilesArguments {
  path?: string;
}

/** 注册最小本地只读工具集。所有路径都锁定在 workspaceRoot 下。 */
export function registerWorkspaceTools(registry: ToolRegistry): void {
  registry.register({
    name: 'read_file',
    description: '读取工作区内文件的指定行范围。',
    permission: 'workspace.read',
    observation: { type: 'workspace.file', operation: 'read' },
    inputSchema: schema({
      path: pathProperty,
      start: { type: 'integer', minimum: 1, maximum: 1_000_000 },
      end: { type: 'integer', minimum: 1, maximum: 1_000_000 },
    }, ['path']),
    execute: readFile,
  });
  registry.register({
    name: 'grep',
    description: '在工作区源码中搜索文本，跳过供应商和构建目录。',
    permission: 'workspace.read',
    observation: { type: 'workspace.file', operation: 'search' },
    inputSchema: schema({
      pattern: { type: 'string', minLength: 1, maxLength: 2000 },
      path: pathProperty,
    }, ['pattern']),
    execute: grep,
  });
  registry.register({
    name: 'list_files',
    description: '列出工作区内的源码文件，帮助 Agent 建立目录上下文。',
    permission: 'workspace.read',
    observation: { type: 'workspace.file', operation: 'list' },
    inputSchema: schema({ path: pathProperty }, []),
    execute: listFiles,
  });
  registry.register({
    name: 'apply_patch',
    description: '预览并应用 UTF-8 文本文件的结构化 Patch；每次写入都需要显式审批。',
    permission: 'workspace.write',
    effect: 'write',
    inputSchema: schema({
      patch: {
        type: 'object',
        properties: {
          version: { type: 'integer', const: 1 },
          operations: {
            type: 'array', minItems: 1, maxItems: 64,
            items: {
              type: 'object',
              properties: {
                op: { type: 'string', enum: ['replace', 'overwrite', 'create', 'delete'] },
                path: pathProperty,
                oldString: { type: 'string', maxLength: 1_000_000 },
                newString: { type: 'string', maxLength: 1_000_000 },
                content: { type: 'string', maxLength: 1_000_000 },
                expectedFileHash: { type: 'string', maxLength: 200 },
                expectedContext: {
                  type: 'object',
                  properties: { before: { type: 'string', maxLength: 20_000 }, after: { type: 'string', maxLength: 20_000 } },
                  additionalProperties: false,
                },
              },
              required: ['op', 'path'],
              additionalProperties: false,
            },
          },
        },
        required: ['version', 'operations'],
        additionalProperties: false,
      },
    }, ['patch']),
    execute: applyStructuredPatch,
  });
}

/**
 * 应用结构化 Patch 并立即写入 Edit Checkpoint。
 *
 * 副作用：属于工作区写操作，调用方（ToolExecutor）必须先完成权限与审批；
 * 每次调用会推进 workspaceRevision 并生成新的 checkpoint，失败时按 PatchError 分类返回。
 */
export async function applyStructuredPatch(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
  try {
    const result = await applyPatch(context.workspaceRoot, args.patch);
    const checkpointId = await saveEditCheckpoint(context.workspaceRoot, result.checkpoint);
    const diff = result.preview.files.map((file) => file.diff).join('\n\n');
    return toolSuccess(
      diff || '[info] Patch 没有产生可见差异',
      `已应用 ${result.preview.changedFiles.length} 个文件的 Patch，checkpoint=${checkpointId}`,
      result.preview.changedFiles.map((file) => `file:${file}`),
      {
        changedFiles: result.preview.changedFiles,
        workspaceRevision: result.preview.workspaceRevision.value,
        checkpointId,
      },
    );
  } catch (error) {
    if (error instanceof PatchError) {
      // 分类原则：context/hash/invalid 归为参数或文本不匹配（invalid），rollback 回滚归为 failed；
      // 未识别的 PatchError 一律归 denied（fail-closed），不会把未知错误放行成成功。
      const status = error.code.includes('context') || error.code.includes('hash') || error.code.includes('invalid')
        ? 'invalid' : error.code.includes('rollback') ? 'failed' : 'denied';
      return toolFailure(status, error.code, error.message, {
        data: { patchCode: error.code, path: error.path },
      });
    }
    return toolFailure('failed', 'tool_failed', 'Patch 执行失败');
  }
}

async function readFile(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
  const { path: relative, start = 1, end = start + 199 } = args as unknown as ReadFileArguments;
  // end 缺省时限定最多 200 行，配合 Schema 的 start/end 上限把单次回读输出封顶，
  // 避免一次读取超大文件导致回填过大。
  if (end < start) return toolFailure('invalid', 'invalid_arguments', '结束行不能小于开始行');
  try {
    const policy = await pathPolicyFor(context.workspaceRoot);
    const { content: fileContent } = await policy.readTextFile(relative);
    const lines = fileContent.split(/\r?\n/);
    const content = lines.slice(start - 1, end).map((line, index) => `${start + index}: ${line}`).join('\n');
    return toolSuccess(content, `read_file ${relative}:${start}-${end}`, [`file:${relative}:${start}`]);
  } catch (error) {
    return pathFailure(error, '读取工作区文件失败');
  }
}

async function grep(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
  const { pattern, path: relative = '.' } = args as unknown as GrepArguments;
  const hits: string[] = [];
  try {
    const policy = await pathPolicyFor(context.workspaceRoot);
    for await (const file of walkSourceFiles(policy, relative, context.signal)) {
      const { content } = await policy.readTextFile(file);
      // 用字面量 includes 而非正则匹配，避免用户输入 pattern 触发 ReDoS；
      // 命中数封顶 100 条，防止超大结果集导致输出膨胀。
      for (const [index, line] of content.split(/\r?\n/).entries()) {
        if (line.includes(pattern)) {
          hits.push(`${displayPath(file)}:${index + 1}: ${line.trim()}`);
          if (hits.length >= 100) break;
        }
      }
      if (hits.length >= 100) break;
    }
  } catch (error) {
    return pathFailure(error, '搜索工作区失败');
  }
  const output = hits.length ? hits.join('\n') : `[info] 未找到 ${pattern}`;
  return toolSuccess(
    output,
    `grep 命中 ${hits.length} 条`,
    hits.slice(0, 20).map((hit) => `grep:${hit.split(':')[0]}`),
  );
}

async function listFiles(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
  const { path: relative = '.' } = args as unknown as ListFilesArguments;
  const files: string[] = [];
  try {
    const policy = await pathPolicyFor(context.workspaceRoot);
    for await (const file of walkSourceFiles(policy, relative, context.signal)) {
      files.push(displayPath(file));
      if (files.length >= 200) break;
    }
  } catch (error) {
    return pathFailure(error, '列出工作区文件失败');
  }
  return toolSuccess(
    files.join('\n') || '[info] 没有找到源码文件',
    `list_files ${files.length} 个文件`,
  );
}

async function* walkSourceFiles(
  policy: PathPolicy,
  relative: string,
  signal: AbortSignal,
): AsyncGenerator<string> {
  const resolved = await policy.resolveExisting(relative);
  if (resolved.stat.isFile()) {
    if (sourceExtensions.has(path.extname(relative).toLowerCase())) yield relative;
    return;
  }
  if (!resolved.stat.isDirectory()) return;
  const { entries } = await policy.readDirectory(relative);
  for (const entry of entries) {
    if (signal.aborted) return;
    // 跳过符号链接，防止经由链接逃逸出 workspace 根；同时跳过供应商/构建目录。
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory() && ignoredDirectories.has(entry.name.toLowerCase())) continue;
    const child = relative === '.' ? entry.name : path.join(relative, entry.name);
    if (entry.isDirectory()) yield* walkSourceFiles(policy, child, signal);
    else if (entry.isFile() && sourceExtensions.has(path.extname(entry.name).toLowerCase())) yield child;
  }
}

function schema(properties: Record<string, JsonSchemaNode>, required: string[]): JsonSchema {
  return { type: 'object', properties, required, additionalProperties: false };
}

function errorResult(content: string): ToolResult {
  return toolFailure('failed', 'tool_failed', content);
}

function pathPolicyFor(workspaceRoot: string): Promise<PathPolicy> {
  // 按 workspaceRoot 缓存 PathPolicy（Windows 归一化大小写），避免重复创建句柄；
  // 创建失败时清掉缓存项，让后续调用可重试而不是永久命中坏缓存。
  const key = process.platform === 'win32'
    ? path.resolve(workspaceRoot).toLowerCase()
    : path.resolve(workspaceRoot);
  let policy = pathPolicies.get(key);
  if (!policy) {
    policy = PathPolicy.create(workspaceRoot);
    pathPolicies.set(key, policy);
    void policy.catch(() => {
      if (pathPolicies.get(key) === policy) pathPolicies.delete(key);
    });
  }
  return policy;
}

function pathFailure(error: unknown, fallback: string): ToolResult {
  if (!(error instanceof PathPolicyError)) return errorResult(fallback);
  const data = { pathPolicyCode: error.code };
  // 未列入下面两组的 PathPolicyError 一律归 denied（fail-closed）：新增错误码不会
  // 意外被当作成功或宽松分类放行，需显式加入分组才会改变归类。
  if (['path_io_error', 'workspace_changed', 'identity_unavailable', 'handle_identity_mismatch'].includes(error.code)) {
    return toolFailure('failed', 'tool_failed', error.message, { data });
  }
  if (['path_not_found', 'not_a_file', 'not_a_directory', 'file_too_large', 'invalid_path', 'path_too_long'].includes(error.code)) {
    return toolFailure('invalid', 'invalid_arguments', error.message, { data });
  }
  return toolFailure('denied', 'permission_denied', error.message, { data });
}

function displayPath(relative: string): string {
  return relative.replaceAll('\\', '/');
}
