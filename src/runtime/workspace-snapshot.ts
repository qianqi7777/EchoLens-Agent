/**
 * 工作区快照：只读地采集工作区目录结构、文件大小与 SHA-256 哈希，作为工具与
 * 审批流程判断「工作区当前状态」的证据。
 *
 * 信任边界：快照读取的是不可信的工作区内容——工具可改动文件、外部进程可能在
 * 采集期间写入。因此快照只能代表某个时间点的状态，不能据此写入系统策略或改变
 * 权限集合。采集统一经 PathPolicy，并拒绝符号链接 / Junction，避免目录枚举越界。
 */
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

// 排除易变、体积大或含敏感信息的目录：避免它们让 revision 频繁抖动，也避免把
// 生成产物当作工具需要观察的源码依据。按小写比较，兼容 Windows 大小写不敏感的目录名。
const DEFAULT_IGNORED = new Set(['.git', '.echolens', 'node_modules', 'dist', 'build', 'coverage']);

export async function captureWorkspaceSnapshot(
  workspaceRoot: string,
  options: WorkspaceSnapshotOptions = {},
): Promise<WorkspaceSnapshot> {
  const policy = await PathPolicy.create(workspaceRoot);
  const ignored = options.ignoredDirectories ?? DEFAULT_IGNORED;
  // 文件数 / 单文件字节数上限：防止超大或文件极多的工作区拖垮采集过程与审批 UI。
  // 上限非法直接抛错，避免负值或非整数把后续逻辑引入歧途。
  const maxFiles = options.maxFiles ?? 10_000;
  const maxFileBytes = options.maxFileBytes ?? 2 * 1024 * 1024;
  if (!Number.isSafeInteger(maxFiles) || maxFiles <= 0) throw new Error('快照文件数上限无效');
  if (!Number.isSafeInteger(maxFileBytes) || maxFileBytes <= 0) throw new Error('快照文件大小上限无效');

  const files: WorkspaceFileSnapshot[] = [];
  await visit('.', files, policy, ignored, maxFiles, maxFileBytes);
  // files 先排序再哈希：目录枚举顺序不确定，排序保证同一工作区内容得到稳定的
  // revision，避免仅因遍历顺序不同被误判为「工作区已变化」。
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

// 返回结构化克隆，避免调用方修改副本后，影响快照中登记的正式 revision。
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
  // 拒绝符号链接 / Junction：它们可指向工作区之外，绕过路径校验造成越界读写。
  // 快照在此直接失败而非跳过，避免把「外表正常、实则指向外部」的状态当作证据。
    if (entry.isSymbolicLink()) throw new PathPolicyError('reparse_point_denied', '快照拒绝符号链接或 Junction');
    if (ignored.has(entry.name.toLowerCase())) continue;
    const child = relative === '.' ? entry.name : path.posix.join(relative.replaceAll('\\', '/'), entry.name);
    if (entry.isDirectory()) {
      files.push({ path: child, size: 0, kind: 'directory' });
      await visit(child, files, policy, ignored, maxFiles, maxFileBytes);
      continue;
    }
    if (!entry.isFile()) continue;
    // 单个文件超过 maxFileBytes 时放弃读取哈希，仅登记条目且 size 记为 0：
    // 这类文件的内容变化不会反映到 revision，工具不应依赖其哈希做精确校验。
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
