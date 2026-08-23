import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { JsonSchema, ToolContext, ToolResult } from './types.js';
import { ToolRegistry } from './tool-registry.js';

const sourceExtensions = new Set([
  '.py', '.ts', '.tsx', '.js', '.jsx', '.go', '.rs', '.java', '.kt', '.cs', '.cpp', '.h',
]);
const ignoredDirectories = new Set(['.git', 'node_modules', '.venv', 'dist', 'build', '.echolens_index']);

/** 注册最小本地只读工具集。所有路径都锁定在 workspaceRoot 下。 */
export function registerWorkspaceTools(registry: ToolRegistry): void {
  registry.register({
    name: 'read_file',
    description: '读取工作区内文件的指定行范围。',
    permission: 'workspace.read',
    inputSchema: schema({ path: 'string', start: 'number', end: 'number' }, ['path']),
    execute: readFile,
  });
  registry.register({
    name: 'grep',
    description: '在工作区源码中搜索文本，跳过供应商和构建目录。',
    permission: 'workspace.read',
    inputSchema: schema({ pattern: 'string', path: 'string' }, ['pattern']),
    execute: grep,
  });
  registry.register({
    name: 'list_files',
    description: '列出工作区内的源码文件，帮助 Agent 建立目录上下文。',
    permission: 'workspace.read',
    inputSchema: schema({ path: 'string' }, []),
    execute: listFiles,
  });
}

async function readFile(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
  const relative = stringArg(args, 'path');
  const file = safePath(context.workspaceRoot, relative);
  if (!file) return errorResult('路径越界，拒绝读取');
  const start = Math.max(1, numberArg(args, 'start', 1));
  const end = Math.max(start, numberArg(args, 'end', start + 199));
  try {
    const lines = (await fs.readFile(file, 'utf8')).split(/\r?\n/);
    const content = lines.slice(start - 1, end).map((line, index) => `${start + index}: ${line}`).join('\n');
    return okResult(content, `read_file ${relative}:${start}-${end}`, [`file:${relative}:${start}`]);
  } catch (error) {
    return errorResult(`读取失败：${error instanceof Error ? error.message : String(error)}`);
  }
}

async function grep(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
  const pattern = stringArg(args, 'pattern');
  const base = safePath(context.workspaceRoot, stringArg(args, 'path', '.'));
  if (!base) return errorResult('路径越界，拒绝搜索');
  const hits: string[] = [];
  for await (const file of walkSourceFiles(base, context.signal)) {
    const content = await fs.readFile(file, 'utf8').catch(() => '');
    content.split(/\r?\n/).forEach((line, index) => {
      if (line.includes(pattern)) {
        hits.push(`${path.relative(context.workspaceRoot, file).replaceAll('\\', '/')}:${index + 1}: ${line.trim()}`);
      }
    });
    if (hits.length >= 100) break;
  }
  const output = hits.length ? hits.join('\n') : `[info] 未找到 ${pattern}`;
  return okResult(output, `grep 命中 ${hits.length} 条`, hits.slice(0, 20).map((hit) => `grep:${hit.split(':')[0]}`));
}

async function listFiles(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
  const base = safePath(context.workspaceRoot, stringArg(args, 'path', '.'));
  if (!base) return errorResult('路径越界，拒绝列目录');
  const files: string[] = [];
  for await (const file of walkSourceFiles(base, context.signal)) {
    files.push(path.relative(context.workspaceRoot, file).replaceAll('\\', '/'));
    if (files.length >= 200) break;
  }
  return okResult(files.join('\n') || '[info] 没有找到源码文件', `list_files ${files.length} 个文件`, []);
}

async function* walkSourceFiles(root: string, signal: AbortSignal): AsyncGenerator<string> {
  const stat = await fs.stat(root).catch(() => null);
  if (!stat) return;
  if (stat.isFile()) {
    if (sourceExtensions.has(path.extname(root).toLowerCase())) yield root;
    return;
  }
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (signal.aborted) return;
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
    const child = path.join(root, entry.name);
    if (entry.isDirectory()) yield* walkSourceFiles(child, signal);
    else if (entry.isFile() && sourceExtensions.has(path.extname(entry.name).toLowerCase())) yield child;
  }
}

function safePath(root: string, relative: string): string | null {
  const rootAbs = path.resolve(root);
  const target = path.resolve(rootAbs, relative);
  const rel = path.relative(rootAbs, target);
  // Git 元数据可能包含凭据、远端地址和内部对象；第一版 Agent 不开放直接读取。
  const parts = rel.split(path.sep).filter(Boolean);
  if (parts.includes('.git')) return null;
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel)) ? target : null;
}

function schema(properties: Record<string, string>, required: string[]): JsonSchema {
  return { type: 'object', properties: Object.fromEntries(Object.entries(properties).map(([key, type]) => [key, { type }])), required, additionalProperties: false };
}

function stringArg(args: Record<string, unknown>, key: string, fallback = ''): string {
  return typeof args[key] === 'string' ? args[key] as string : fallback;
}

function numberArg(args: Record<string, unknown>, key: string, fallback: number): number {
  return typeof args[key] === 'number' && Number.isFinite(args[key]) ? args[key] as number : fallback;
}

function okResult(content: string, summary: string, evidenceIds: string[]): ToolResult {
  return { status: 'ok', content, summary, evidenceIds };
}

function errorResult(content: string): ToolResult {
  return { status: 'error', content, summary: 'tool_error', evidenceIds: [] };
}
