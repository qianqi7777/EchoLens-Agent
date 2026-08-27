import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import * as path from 'node:path';
import { PathPolicy, PathPolicyError } from './path-policy.js';

export interface WorkspaceFileSnapshot {
  path: string;
  hash?: string;
  size: number;
  kind: 'file' | 'directory';
}

export interface WorkspaceRevision {
  value: string;
  capturedAt: string;
  fileCount: number;
}

export interface WorkspaceSnapshot {
  version: 1;
  root: string;
  revision: WorkspaceRevision;
  gitHead?: string;
  gitDirty?: boolean;
  files: WorkspaceFileSnapshot[];
}

export interface WorkspaceSnapshotOptions {
  maxFiles?: number;
  maxFileBytes?: number;
  ignoredDirectories?: ReadonlySet<string>;
}

const DEFAULT_IGNORED = new Set(['.git', '.echolens', 'node_modules', 'dist', 'build', 'coverage']);

export async function captureWorkspaceSnapshot(
  workspaceRoot: string,
  options: WorkspaceSnapshotOptions = {},
): Promise<WorkspaceSnapshot> {
  const policy = await PathPolicy.create(workspaceRoot);
  const ignored = options.ignoredDirectories ?? DEFAULT_IGNORED;
  const maxFiles = options.maxFiles ?? 10_000;
  const maxFileBytes = options.maxFileBytes ?? 2 * 1024 * 1024;
  if (!Number.isSafeInteger(maxFiles) || maxFiles <= 0) throw new Error('快照文件数上限无效');
  if (!Number.isSafeInteger(maxFileBytes) || maxFileBytes <= 0) throw new Error('快照文件大小上限无效');

  const files: WorkspaceFileSnapshot[] = [];
  await visit('.', files, policy, ignored, maxFiles, maxFileBytes);
  files.sort((left, right) => left.path.localeCompare(right.path));
  const revisionValue = hash(JSON.stringify(files));
  const git = await gitMetadata(policy.workspaceRoot);
  return {
    version: 1,
    root: policy.workspaceRoot,
    revision: {
      value: `sha256:${revisionValue}`,
      capturedAt: new Date().toISOString(),
      fileCount: files.length,
    },
    gitHead: git.head,
    gitDirty: git.dirty,
    files,
  };
}

export function snapshotRevision(snapshot: WorkspaceSnapshot): WorkspaceRevision {
  return structuredClone(snapshot.revision);
}

export function snapshotFile(snapshot: WorkspaceSnapshot, relativePath: string): WorkspaceFileSnapshot | undefined {
  const normalized = relativePath.replaceAll('\\', '/').replace(/^\.\//u, '');
  return snapshot.files.find((entry) => entry.path === normalized);
}

async function visit(
  relative: string,
  files: WorkspaceFileSnapshot[],
  policy: PathPolicy,
  ignored: ReadonlySet<string>,
  maxFiles: number,
  maxFileBytes: number,
): Promise<void> {
  if (files.length >= maxFiles) throw new Error(`工作区文件数超过快照上限：${maxFiles}`);
  const directory = await policy.readDirectory(relative);
  for (const entry of directory.entries) {
    if (files.length >= maxFiles) throw new Error(`工作区文件数超过快照上限：${maxFiles}`);
    if (entry.isSymbolicLink()) throw new PathPolicyError('reparse_point_denied', '快照拒绝符号链接或 Junction');
    if (ignored.has(entry.name.toLowerCase())) continue;
    const child = relative === '.' ? entry.name : path.posix.join(relative.replaceAll('\\', '/'), entry.name);
    if (entry.isDirectory()) {
      files.push({ path: child, size: 0, kind: 'directory' });
      await visit(child, files, policy, ignored, maxFiles, maxFileBytes);
      continue;
    }
    if (!entry.isFile()) continue;
    const bytes = await policy.readFileBytes(child, maxFileBytes).then((result) => result.bytes).catch((error) => {
      if (error instanceof PathPolicyError && error.code === 'file_too_large') return undefined;
      throw error;
    });
    files.push({
      path: child,
      size: bytes?.byteLength ?? 0,
      hash: bytes ? `sha256:${hash(bytes)}` : undefined,
      kind: 'file',
    });
  }
}

async function readGitHead(root: string): Promise<string | undefined> {
  try {
    const head = (await readFile(path.join(root, '.git', 'HEAD'), 'utf8')).trim();
    if (!head) return undefined;
    if (!head.startsWith('ref: ')) return head.slice(0, 200);
    const ref = head.slice('ref: '.length).trim();
    return (await readFile(path.join(root, '.git', ref), 'utf8')).trim().slice(0, 200);
  } catch {
    return undefined;
  }
}

async function gitMetadata(root: string): Promise<{ head?: string; dirty?: boolean }> {
  try {
    const run = promisify(execFile);
    const head = (await run('git', ['-C', root, 'rev-parse', 'HEAD'], { windowsHide: true, maxBuffer: 16_384 })).stdout.trim();
    const status = (await run('git', ['-C', root, 'status', '--porcelain=v1', '--untracked-files=all'], { windowsHide: true, maxBuffer: 1_048_576 })).stdout.trim();
    return { head: head || undefined, dirty: status.length > 0 };
  } catch {
    return { head: await readGitHead(root) };
  }
}

function hash(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}
