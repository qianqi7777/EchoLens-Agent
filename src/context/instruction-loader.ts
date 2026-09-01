import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import type { Permission } from '../core/permissions.js';
import {
  DEFAULT_INSTRUCTION_DISCOVERY_POLICY,
  type InstructionDocument,
  type InstructionPermissionDirective,
  type InstructionSource,
} from './instruction-types.js';

const PERMISSIONS = new Set<Permission>([
  'workspace.read',
  'workspace.write',
  'process.exec',
  'network.request',
  'external.invoke',
]);
// 指令正则刻意只允许 deny / request_approval，不含 allow：
// 规则文件不可信，只能收紧权限或申请审批，不能放宽；reason 限长 240 字符，
// 防止把超大字符串灌入待审理由。
const DIRECTIVE_PATTERN = /<!--\s*echolens:\s*(deny|request_approval)\s+(workspace\.read|workspace\.write|process\.exec|network\.request|external\.invoke)(?:\s+reason="([^"]{1,240})")?\s*-->/gu;

export interface InstructionLoaderOptions {
  workspaceRoot: string;
  userInstructionDirectory?: string;
  configuredFallbacks?: readonly string[];
  maxCombinedBytes?: number;
}

export interface InstructionLoadResult {
  documents: InstructionDocument[];
  warnings: string[];
  totalBytes: number;
}

export class InstructionLoader {
  private readonly workspaceRoot: string;
  private readonly userInstructionDirectory?: string;
  private readonly configuredFallbacks: readonly string[];
  private readonly maxCombinedBytes: number;

  constructor(options: InstructionLoaderOptions) {
    this.workspaceRoot = resolve(options.workspaceRoot);
    this.userInstructionDirectory = options.userInstructionDirectory
      ? resolve(options.userInstructionDirectory)
      : undefined;
    this.configuredFallbacks = options.configuredFallbacks ?? [];
    this.maxCombinedBytes = options.maxCombinedBytes
      ?? DEFAULT_INSTRUCTION_DISCOVERY_POLICY.maxCombinedBytes;
  }

  async load(targetPath = '.'): Promise<InstructionLoadResult> {
    // 整次发现统一使用规范根路径，避免 Windows 8.3 短路径、大小写别名或 Junction
    // 让同一目录在 lstat/realpath 前后呈现为不同字符串。
    const workspaceRoot = await realpath(this.workspaceRoot);
    const warnings: string[] = [];
    const candidates: Array<{
      path: string;
      kind: InstructionSource['kind'];
      fileKind: NonNullable<InstructionSource['fileKind']>;
      trust: 'user' | 'repository';
      depth: number;
      appliesTo: string;
    }> = [];

    // 合并顺序 = 全局用户规则 → 工作区根 → 目标目录（root-to-target），
    // discoveryOrder 记录实际顺序；同目录只选一个候选（override 优先）。
    if (this.userInstructionDirectory) {
      const selected = await selectInstructionFile(
        this.userInstructionDirectory,
        ['AGENTS.override.md', 'AGENTS.md'],
        warnings,
      );
      if (selected) candidates.push({
        path: selected.path,
        kind: 'user_global',
        fileKind: selected.fileKind,
        trust: 'user',
        depth: -1,
        appliesTo: workspaceRoot,
      });
    }

    const targetDirectory = await this.resolveTargetDirectory(workspaceRoot, targetPath);
    const directories = directoriesFromRoot(workspaceRoot, targetDirectory);
    for (const [depth, directory] of directories.entries()) {
      const selected = await selectInstructionFile(
        directory,
        ['AGENTS.override.md', 'AGENTS.md', ...this.configuredFallbacks],
        warnings,
      );
      if (!selected) continue;
      candidates.push({
        path: selected.path,
        kind: depth === 0 ? 'project_root' : 'project_directory',
        fileKind: selected.fileKind,
        trust: 'repository',
        depth,
        appliesTo: directory,
      });
    }

    const documents: InstructionDocument[] = [];
    let totalBytes = 0;
    for (const [discoveryOrder, candidate] of candidates.entries()) {
      // 规则文件不可信，用总字节上限（默认 32KB）约束其体积，防止拖垮上下文预算。
      const remaining = Math.max(0, this.maxCombinedBytes - totalBytes);
      if (remaining === 0) {
        warnings.push(`规则总大小超过 ${this.maxCombinedBytes} 字节，已跳过 ${candidate.path}`);
        continue;
      }
      const bytes = await readSafeInstruction(candidate.path, candidate.trust === 'repository'
        ? workspaceRoot : undefined);
      if (!bytes) {
        warnings.push(`规则文件不是安全的普通文件，已跳过 ${candidate.path}`);
        continue;
      }
      const selectedBytes = bytes.subarray(0, remaining);
      const content = new TextDecoder('utf-8').decode(selectedBytes);
      const truncated = selectedBytes.byteLength < bytes.byteLength;
      const source: InstructionSource = {
        id: `instruction:${createHash('sha256').update(candidate.path).digest('hex').slice(0, 16)}`,
        kind: candidate.kind,
        fileKind: candidate.fileKind,
        trust: candidate.trust,
        uri: candidate.path,
        scope: {
          workspaceRoot,
          directory: candidate.appliesTo,
          appliesTo: candidate.appliesTo,
          depth: candidate.depth,
        },
        discoveryOrder,
        contentHash: createHash('sha256').update(bytes).digest('hex'),
        byteLength: bytes.byteLength,
      };
      const documentWarnings = truncated ? ['规则文件因总大小限制被截断'] : [];
      documents.push({
        source,
        content,
        truncated,
        warnings: documentWarnings,
        permissionDirectives: parsePermissionDirectives(content, source),
      });
      totalBytes += selectedBytes.byteLength;
    }
    return { documents, warnings, totalBytes };
  }

  private async resolveTargetDirectory(workspaceRoot: string, targetPath: string): Promise<string> {
    const target = resolve(workspaceRoot, targetPath);
    assertWithin(workspaceRoot, target);
    try {
      const info = await lstat(target);
      return info.isDirectory() ? target : dirname(target);
    } catch {
      return dirname(target);
    }
  }
}

function parsePermissionDirectives(
  content: string,
  source: InstructionSource,
): InstructionPermissionDirective[] {
  const directives: InstructionPermissionDirective[] = [];
  for (const [index, match] of [...content.matchAll(DIRECTIVE_PATTERN)].entries()) {
    const effect = match[1] as InstructionPermissionDirective['effect'];
    const permission = match[2] as Permission;
    if (!PERMISSIONS.has(permission)) continue;
    directives.push({
      id: `${source.id}:permission:${index + 1}`,
      sourceId: source.id,
      sourceTrust: source.trust === 'user' ? 'user' : 'repository',
      effect,
      permission,
      reason: match[3] ?? `${source.fileKind ?? 'instruction'} requested ${effect}`,
    });
  }
  return directives;
}

async function selectInstructionFile(
  directory: string,
  fileNames: readonly string[],
  warnings: string[],
): Promise<{ path: string; fileKind: NonNullable<InstructionSource['fileKind']> } | undefined> {
  for (const fileName of fileNames) {
    const path = resolve(directory, fileName);
    try {
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink()) {
        warnings.push(`规则候选不是普通文件，已跳过 ${path}`);
        continue;
      }
      return { path, fileKind: fileKind(fileName) };
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) continue;
      warnings.push(`无法检查规则文件 ${path}`);
    }
  }
  return undefined;
}

// 仓库规则来自不可信工作区：拒绝符号链接，并把规则文件 realpath 与 load() 已规范化的
// workspaceRoot 校验包含关系，防止规则文件通过符号链接逃逸到工作区之外。
async function readSafeInstruction(path: string, workspaceRoot?: string): Promise<Buffer | undefined> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) return undefined;
  if (workspaceRoot) {
    const finalPath = await realpath(path);
    assertWithin(workspaceRoot, finalPath);
  }
  return readFile(path);
}

function directoriesFromRoot(root: string, target: string): string[] {
  assertWithin(root, target);
  const suffix = relative(root, target);
  const parts = suffix ? suffix.split(/[\\/]/u).filter(Boolean) : [];
  const directories = [root];
  for (let index = 1; index <= parts.length; index += 1) {
    directories.push(resolve(root, ...parts.slice(0, index)));
  }
  return directories;
}

// 路径穿越校验：目标一旦解析到工作区之外（.. 前缀或越界）即抛错，
// 防止规则发现与读取逃逸出工作区。
function assertWithin(root: string, target: string): void {
  const suffix = relative(resolve(root), resolve(target));
  if (isAbsolute(suffix) || suffix === '..' || suffix.startsWith(`..${sep}`)) {
    throw new Error('规则目标路径位于工作区之外');
  }
}

function fileKind(fileName: string): NonNullable<InstructionSource['fileKind']> {
  if (fileName === 'AGENTS.override.md') return 'agents_override';
  if (fileName === 'AGENTS.md') return 'agents';
  return 'configured_fallback';
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === code;
}
