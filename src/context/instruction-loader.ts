import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';
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
    const warnings: string[] = [];
    const candidates: Array<{
      path: string;
      kind: InstructionSource['kind'];
      fileKind: NonNullable<InstructionSource['fileKind']>;
      trust: 'user' | 'repository';
      depth: number;
      appliesTo: string;
    }> = [];

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
        appliesTo: this.workspaceRoot,
      });
    }

    const targetDirectory = await this.resolveTargetDirectory(targetPath);
    const directories = directoriesFromRoot(this.workspaceRoot, targetDirectory);
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
      const remaining = Math.max(0, this.maxCombinedBytes - totalBytes);
      if (remaining === 0) {
        warnings.push(`规则总大小超过 ${this.maxCombinedBytes} 字节，已跳过 ${candidate.path}`);
        continue;
      }
      const bytes = await readSafeInstruction(candidate.path, candidate.trust === 'repository'
        ? this.workspaceRoot : undefined);
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
          workspaceRoot: this.workspaceRoot,
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

  private async resolveTargetDirectory(targetPath: string): Promise<string> {
    const target = resolve(this.workspaceRoot, targetPath);
    assertWithin(this.workspaceRoot, target);
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

function assertWithin(root: string, target: string): void {
  const suffix = relative(resolve(root), resolve(target));
  if (suffix === '..' || suffix.startsWith(`..${sep}`) || resolve(target) === '') {
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
