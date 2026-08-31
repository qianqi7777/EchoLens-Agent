import { execFile } from 'node:child_process';
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { PathPolicy, PathPolicyError } from '../runtime/path-policy.js';
import { SandboxError } from './types.js';

export interface StagedWorkspace {
  root: string;
  fileCount: number;
  totalBytes: number;
  baseline: readonly StagedFileSnapshot[];
  cleanup(): Promise<void>;
}

export interface StagedFileSnapshot {
  path: string;
  bytes: Buffer;
  mode: number;
}

export interface WorkspaceStager {
  prepare(workspaceRoot: string, id: string): Promise<StagedWorkspace>;
}

export interface FileSystemWorkspaceStagerOptions {
  maxFiles?: number;
  maxFileBytes?: number;
  maxTotalBytes?: number;
}

const PRIVATE_NAMES = new Set(['.git', '.echolens', 'node_modules', 'studydocs', 'coverage', 'dist', 'build']);

export class FileSystemWorkspaceStager implements WorkspaceStager {
  private readonly maxFiles: number;
  private readonly maxFileBytes: number;
  private readonly maxTotalBytes: number;

  constructor(options: FileSystemWorkspaceStagerOptions = {}) {
    this.maxFiles = options.maxFiles ?? 20_000;
    this.maxFileBytes = options.maxFileBytes ?? 2 * 1024 * 1024;
    this.maxTotalBytes = options.maxTotalBytes ?? 64 * 1024 * 1024;
  }

  async prepare(workspaceRoot: string, id: string): Promise<StagedWorkspace> {
    // id 是每次运行生成的随机 UUID，被拼进暂存目录路径；严格校验避免路径拼接被插入任意片段。
    if (!/^echolens-[a-f0-9-]{36}$/u.test(id)) throw new SandboxError('sandbox_stage_failed', 'Sandbox 工作区 ID 无效');
    const policy = await PathPolicy.create(workspaceRoot);
    const sandboxBase = path.join(policy.workspaceRoot, '.echolens', 'sandboxes');
    const targetBase = path.join(sandboxBase, id);
    const targetRoot = path.join(targetBase, 'workspace');
    assertInside(sandboxBase, targetBase);
    await mkdir(targetRoot, { recursive: true });
    try {
      const candidates = await gitVisibleFiles(policy.workspaceRoot) ?? await walkVisibleFiles(policy, '.');
      const files = [...new Set(candidates.map(normalizeRelative).filter(isPublicPath))].sort();
      if (files.length > this.maxFiles) throw new SandboxError('sandbox_stage_failed', `Sandbox 快照文件数超过 ${this.maxFiles}`);
      let totalBytes = 0;
      let fileCount = 0;
      const baseline: StagedFileSnapshot[] = [];
      for (const relative of files) {
        const source = await policy.readFileBytes(relative, this.maxFileBytes).catch((error) => {
          if (error instanceof PathPolicyError && error.code === 'path_not_found') return undefined;
          if (error instanceof PathPolicyError && error.code === 'file_too_large') {
            throw new SandboxError('sandbox_stage_failed', `Sandbox 快照文件过大：${relative}`);
          }
          throw error;
        });
        if (!source) continue;
        totalBytes += source.bytes.byteLength;
        if (totalBytes > this.maxTotalBytes) throw new SandboxError('sandbox_stage_failed', `Sandbox 快照超过 ${this.maxTotalBytes} bytes`);
        const target = path.join(targetRoot, ...relative.split('/'));
        assertInside(targetRoot, target);
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, source.bytes, { mode: 0o644 });
        // 源文件带可执行位时保留 0o755；在 POSIX 下这是真实的执行权限，Windows 的 mode 位不全时该条件自然为假，
        // 不会误加权限，只在源文件确有可执行语义时补齐容器内的执行位。
        const sourceStat = await policy.resolveExisting(relative, 'file');
        if ((Number(sourceStat.stat.mode) & 0o111) !== 0) await chmod(target, 0o755);
        baseline.push({ path: relative, bytes: Buffer.from(source.bytes), mode: Number(sourceStat.stat.mode) });
        fileCount += 1;
      }
      return {
        root: targetRoot,
        fileCount,
        totalBytes,
        baseline,
        cleanup: async () => {
          assertInside(sandboxBase, targetBase);
          await rm(targetBase, { recursive: true, force: true });
        },
      };
    } catch (error) {
      await rm(targetBase, { recursive: true, force: true }).catch(() => undefined);
      if (error instanceof SandboxError) throw error;
      throw new SandboxError('sandbox_stage_failed', `无法准备 Sandbox 工作区：${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

// 优先用 git ls-files（--cached --modified --others --exclude-standard）获得“被跟踪 + 未忽略”的文件清单，
// 从而尊重 .gitignore；git 不可用（如非 Git 目录）时回退到手动遍历。
async function gitVisibleFiles(root: string): Promise<string[] | undefined> {
  try {
    const result = await promisify(execFile)('git', [
      '-C', root, 'ls-files', '-z', '--cached', '--modified', '--others', '--exclude-standard',
    ], { windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
    return result.stdout.split('\0').filter(Boolean);
  } catch {
    return undefined;
  }
}

async function walkVisibleFiles(policy: PathPolicy, relative: string): Promise<string[]> {
  const directory = await policy.readDirectory(relative);
  const files: string[] = [];
  for (const entry of directory.entries) {
    const child = relative === '.' ? entry.name : `${relative.replaceAll('\\', '/')}/${entry.name}`;
    if (!isPublicPath(child)) continue;
    // 符号链接可能指向工作区其他位置，拷入容器会扩大暴露面；直接拒绝、不跟随。
    if (entry.isSymbolicLink()) throw new SandboxError('sandbox_stage_failed', `Sandbox 快照拒绝符号链接：${child}`);
    if (entry.isDirectory()) files.push(...await walkVisibleFiles(policy, child));
    else if (entry.isFile()) files.push(child);
  }
  return files;
}

// 任意路径段命中 PRIVATE_NAMES 或以 .env/.env.* 开头都被排除，确保密钥文件不会被拷入容器。
function isPublicPath(relative: string): boolean {
  const segments = normalizeRelative(relative).split('/').filter(Boolean);
  return !segments.some((segment) => PRIVATE_NAMES.has(segment.toLowerCase())
    || segment.toLowerCase() === '.env'
    || segment.toLowerCase().startsWith('.env.'));
}

function normalizeRelative(value: string): string {
  return value.replaceAll('\\', '/').replace(/^\.\//u, '');
}

function assertInside(root: string, candidate: string): void {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new SandboxError('sandbox_stage_failed', 'Sandbox 暂存路径越界');
  }
}
