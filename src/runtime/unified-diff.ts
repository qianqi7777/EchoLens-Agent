import { createHash } from 'node:crypto';
import { PathPolicy } from './path-policy.js';
import type { StructuredPatch } from './structured-patch.js';
import type { ToolContext } from './types.js';
import { ToolRegistry } from './tool-registry.js';
import { objectSchema } from './tool-schema.js';
import { applyStructuredPatch } from './workspace-tools.js';

interface FilePatch { path: string; oldPath?: string; hunks: Hunk[]; create: boolean; delete: boolean; noNewline: boolean }
interface Hunk { oldStart: number; oldCount: number; lines: string[] }

/** 将 unified diff 严格转换为现有 StructuredPatch；本模块不直接写文件。 */
export function registerUnifiedDiffTool(registry: ToolRegistry): void {
  registry.register({
    name: 'apply_unified_diff', description: '解析标准 unified diff 并通过既有结构化 Patch 管线应用。',
    permission: 'workspace.write', effect: 'write',
    inputSchema: objectSchema({ diff: { type: 'string', minLength: 1, maxLength: 2_000_000 } }, ['diff']),
    execute: async (args, context) => applyUnifiedDiff(String(args.diff), context),
  });
}

export async function parseUnifiedDiff(diff: string, workspaceRoot: string): Promise<StructuredPatch> {
  const filePatches = parseFiles(diff);
  if (filePatches.length === 0) throw new Error('Unified diff 没有文件补丁');
  const policy = await PathPolicy.create(workspaceRoot);
  const operations: StructuredPatch['operations'] = [];
  for (const filePatch of filePatches) {
    const relative = filePatch.path;
    if (filePatch.create) {
      operations.push({ op: 'create', path: relative, content: materializeNewFile(filePatch) });
      continue;
    }
    const { content: current } = await policy.readTextFile(relative);
    const next = applyHunks(current, filePatch.hunks);
    const expectedFileHash = hash(current);
    if (filePatch.delete) operations.push({ op: 'delete', path: relative, expectedFileHash });
    else operations.push({ op: 'overwrite', path: relative, content: next, expectedFileHash });
  }
  return { version: 1, operations };
}

async function applyUnifiedDiff(diff: string, context: ToolContext) {
  try {
    const patch = await parseUnifiedDiff(diff, context.workspaceRoot);
    return applyStructuredPatch({ patch }, context);
  } catch (error) {
    return {
      status: 'invalid' as const,
      content: JSON.stringify({ error: { code: 'patch_invalid', message: error instanceof Error ? error.message : 'Unified diff 无效' } }),
      summary: error instanceof Error ? error.message : 'Unified diff 无效',
      error: { code: 'patch_invalid' as const, message: error instanceof Error ? error.message : 'Unified diff 无效', retryable: false },
      evidenceIds: [],
    };
  }
}

function parseFiles(diff: string): FilePatch[] {
  const lines = diff.replaceAll('\r\n', '\n').split('\n');
  const result: FilePatch[] = [];
  let current: FilePatch | undefined;
  let hunk: Hunk | undefined;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (line.startsWith('--- ')) {
      const oldPath = patchPath(line.slice(4));
      const next = lines[index + 1];
      if (next && next.startsWith('+++ ')) {
        const newPath = patchPath(next.slice(4));
        current = { path: newPath === '/dev/null' ? oldPath : newPath, oldPath, hunks: [], create: oldPath === '/dev/null', delete: newPath === '/dev/null', noNewline: false };
        result.push(current);
      }
      hunk = undefined;
      continue;
    }
    if (line.startsWith('+++ ')) continue;
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/u.exec(line);
    if (header && current) {
      hunk = { oldStart: Number(header[1]), oldCount: Number(header[2] ?? 1), lines: [] };
      current.hunks.push(hunk);
      continue;
    }
    if (hunk && /^[ +\-]/u.test(line)) hunk.lines.push(line);
    else if (line === '\\ No newline at end of file') { if (current) current.noNewline = true; }
    else if (line && !line.startsWith('diff ') && !line.startsWith('index ') && !line.startsWith('new file') && !line.startsWith('deleted file')) throw new Error(`Unified diff 行无效：${line.slice(0, 80)}`);
  }
  for (const file of result) if (file.hunks.length === 0) throw new Error(`文件 ${file.path} 缺少 hunk`);
  return result;
}

function patchPath(value: string): string {
  const token = value.trim().split(/\s+/u)[0] ?? '';
  if (token === '/dev/null') return token;
  const path = token.replace(/^[ab]\//u, '').replaceAll('\\', '/');
  if (!path || path.startsWith('/') || path.split('/').includes('..') || path.includes('\0')) throw new Error('Unified diff 路径越界或无效');
  return path;
}

function materializeNewFile(file: FilePatch): string {
  const content = applyHunks('', file.hunks);
  return !file.noNewline && !content.endsWith('\n') ? `${content}\n` : content;
}

function applyHunks(content: string, hunks: readonly Hunk[]): string {
  const eol = content.includes('\r\n') ? '\r\n' : '\n';
  const source = content.replaceAll('\r\n', '\n').split('\n');
  if (source.length && source.at(-1) === '') source.pop();
  let offset = 0;
  for (const hunk of hunks) {
    const index = Math.max(0, hunk.oldStart - 1 + offset);
    const oldLines = hunk.lines.filter((line) => line.startsWith(' ') || line.startsWith('-')).map((line) => line.slice(1));
    const actual = source.slice(index, index + oldLines.length);
    if (actual.length !== oldLines.length || actual.some((line, i) => line !== oldLines[i])) throw new Error('Unified diff 上下文不匹配');
    const replacement = hunk.lines.filter((line) => line.startsWith(' ') || line.startsWith('+')).map((line) => line.slice(1));
    source.splice(index, oldLines.length, ...replacement);
    offset += replacement.length - oldLines.length;
  }
  return source.join(eol) + (content.endsWith('\n') || content.endsWith('\r\n') ? eol : '');
}

function hash(content: string): string { return `sha256:${createHash('sha256').update(Buffer.from(content, 'utf8')).digest('hex')}`; }
