import type { BigIntStats, Dirent } from 'node:fs';
import { lstat, open, readdir, realpath, stat, unlink, type FileHandle } from 'node:fs/promises';
import * as path from 'node:path';

export const DEFAULT_MAX_TEXT_FILE_BYTES = 2 * 1024 * 1024;

export type PathPolicyErrorCode =
  | 'invalid_path'
  | 'path_too_long'
  | 'absolute_path'
  | 'unc_path'
  | 'device_path'
  | 'drive_relative_path'
  | 'alternate_data_stream'
  | 'short_name'
  | 'reserved_name'
  | 'trailing_dot_or_space'
  | 'path_outside_workspace'
  | 'git_metadata_denied'
  | 'private_metadata_denied'
  | 'reparse_point_denied'
  | 'path_not_found'
  | 'not_a_file'
  | 'not_a_directory'
  | 'file_too_large'
  | 'workspace_changed'
  | 'identity_unavailable'
  | 'handle_identity_mismatch'
  | 'path_io_error';

export class PathPolicyError extends Error {
  constructor(
    readonly code: PathPolicyErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'PathPolicyError';
  }
}

export interface VerifiedFile {
  canonicalPath: string;
  handle: FileHandle;
}

export interface VerifiedCreateFile {
  canonicalPath: string;
  handle: FileHandle;
}

export interface VerifiedDirectory {
  canonicalPath: string;
  entries: Dirent[];
}

export interface PathPolicyOptions {
  afterHandleOpen?: (details: {
    input: string;
    candidatePath: string;
    canonicalPath: string;
    kind: 'file' | 'directory';
  }) => Promise<void>;
}

interface ResolvedPath {
  input: string;
  candidatePath: string;
  canonicalPath: string;
  stat: BigIntStats;
}

export class PathPolicy {
  private constructor(
    readonly workspaceRoot: string,
    private readonly rootIdentity: FileIdentity,
    private readonly options: PathPolicyOptions,
  ) {}

  static async create(workspaceRoot: string, options: PathPolicyOptions = {}): Promise<PathPolicy> {
    const rootInput = path.resolve(workspaceRoot);
    const rootLink = await lstat(rootInput, { bigint: true }).catch((error) => {
      throw ioError(error, '工作区根目录不存在');
    });
    if (rootLink.isSymbolicLink()) {
      throw new PathPolicyError('reparse_point_denied', '工作区根目录不能是符号链接或 Junction');
    }
    const canonical = await realpath(rootInput).catch((error) => {
      throw ioError(error, '无法解析工作区根目录');
    });
    const rootStat = await stat(canonical, { bigint: true }).catch((error) => {
      throw ioError(error, '无法读取工作区根目录');
    });
    if (!rootStat.isDirectory()) throw new PathPolicyError('not_a_directory', '工作区根路径不是目录');
    return new PathPolicy(canonical, identity(rootStat), options);
  }

  async readTextFile(
    input: string,
    maxBytes = DEFAULT_MAX_TEXT_FILE_BYTES,
  ): Promise<{ canonicalPath: string; content: string }> {
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > DEFAULT_MAX_TEXT_FILE_BYTES) {
      throw new PathPolicyError('invalid_path', '文本读取上限必须是有效的正整数');
    }
    const verified = await this.openFile(input);
    try {
      const openedStat = await verified.handle.stat({ bigint: true }).catch((error) => {
        throw ioError(error, '无法读取已打开文件大小');
      });
      if (openedStat.size > BigInt(maxBytes)) {
        throw new PathPolicyError('file_too_large', `文件超过读取上限：${maxBytes} bytes`);
      }
      const buffer = Buffer.allocUnsafe(Math.min(maxBytes + 1, Number(openedStat.size) + 1));
      const { bytesRead } = await verified.handle.read(buffer, 0, buffer.length, 0).catch((error) => {
        throw ioError(error, '无法读取工作区文件');
      });
      const finalStat = await verified.handle.stat({ bigint: true }).catch((error) => {
        throw ioError(error, '无法复核已打开文件大小');
      });
      if (bytesRead > maxBytes || finalStat.size > BigInt(maxBytes)) {
        throw new PathPolicyError('file_too_large', `文件超过读取上限：${maxBytes} bytes`);
      }
      if (finalStat.size !== openedStat.size) {
        throw new PathPolicyError('path_io_error', '文件在读取期间发生变化');
      }
      return {
        canonicalPath: verified.canonicalPath,
        content: buffer.subarray(0, bytesRead).toString('utf8'),
      };
    } finally {
      await verified.handle.close();
    }
  }

  async readFileBytes(
    input: string,
    maxBytes = DEFAULT_MAX_TEXT_FILE_BYTES,
  ): Promise<{ canonicalPath: string; bytes: Buffer }> {
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > DEFAULT_MAX_TEXT_FILE_BYTES) {
      throw new PathPolicyError('invalid_path', '文件读取上限必须是有效的正整数');
    }
    const verified = await this.openFile(input);
    try {
      const openedStat = await verified.handle.stat({ bigint: true }).catch((error) => {
        throw ioError(error, '无法读取已打开文件大小');
      });
      if (openedStat.size > BigInt(maxBytes)) {
        throw new PathPolicyError('file_too_large', `文件超过读取上限：${maxBytes} bytes`);
      }
      const buffer = Buffer.allocUnsafe(Math.min(maxBytes + 1, Number(openedStat.size) + 1));
      const { bytesRead } = await verified.handle.read(buffer, 0, buffer.length, 0).catch((error) => {
        throw ioError(error, '无法读取工作区文件');
      });
      const finalStat = await verified.handle.stat({ bigint: true }).catch((error) => {
        throw ioError(error, '无法复核已打开文件大小');
      });
      if (bytesRead > maxBytes || finalStat.size > BigInt(maxBytes)) {
        throw new PathPolicyError('file_too_large', `文件超过读取上限：${maxBytes} bytes`);
      }
      if (finalStat.size !== openedStat.size) {
        throw new PathPolicyError('path_io_error', '文件在读取期间发生变化');
      }
      return { canonicalPath: verified.canonicalPath, bytes: buffer.subarray(0, bytesRead) };
    } finally {
      await verified.handle.close();
    }
  }

  async openFileForWrite(input: string): Promise<VerifiedFile> {
    const resolved = await this.resolveExisting(input, 'file');
    const handle = await open(resolved.candidatePath, 'r+').catch((error) => {
      throw ioError(error, '无法以写入方式打开工作区文件');
    });
    try {
      const canonicalPath = await this.verifyHandle(resolved, handle, 'file');
      return { canonicalPath, handle };
    } catch (error) {
      await handle.close();
      throw error;
    }
  }

  async createFile(input: string): Promise<VerifiedCreateFile> {
    validateRelativePath(input);
    await this.assertRootIdentity();
    const candidatePath = path.resolve(this.workspaceRoot, input);
    this.assertInside(candidatePath);
    this.assertForbiddenSegments(candidatePath);
    const parentPath = path.dirname(candidatePath);
    const parentRelative = path.relative(this.workspaceRoot, parentPath) || '.';
    await this.resolveExisting(parentRelative, 'directory');
    try {
      const handle = await open(candidatePath, 'wx+');
      try {
        const canonicalPath = await this.verifyNewHandle(input, candidatePath, handle);
        return { canonicalPath, handle };
      } catch (error) {
        await handle.close();
        await unlink(candidatePath).catch(() => undefined);
        throw error;
      }
    } catch (error) {
      if (error instanceof PathPolicyError) throw error;
      const code = isNodeError(error) && error.code === 'EEXIST' ? 'path_io_error' : undefined;
      throw new PathPolicyError(code ?? 'path_io_error', code ? '目标文件已存在' : '无法创建工作区文件');
    }
  }

  async deleteFile(input: string): Promise<string> {
    const verified = await this.openFile(input);
    try {
      try {
        await unlink(verified.canonicalPath);
      } catch (error) {
        // Some Windows file systems reject unlink while a read handle is open.
        await verified.handle.close();
        await unlink(verified.canonicalPath).catch((retryError) => {
          throw ioError(retryError, '无法删除工作区文件');
        });
      }
      return verified.canonicalPath;
    } finally {
      await verified.handle.close().catch(() => undefined);
    }
  }

  async openFile(input: string): Promise<VerifiedFile> {
    const resolved = await this.resolveExisting(input, 'file');
    const handle = await open(resolved.candidatePath, 'r').catch((error) => {
      throw ioError(error, '无法打开工作区文件');
    });
    try {
      const canonicalPath = await this.verifyHandle(resolved, handle, 'file');
      return { canonicalPath, handle };
    } catch (error) {
      await handle.close();
      throw error;
    }
  }

  async readDirectory(input: string): Promise<VerifiedDirectory> {
    const resolved = await this.resolveExisting(input, 'directory');
    const handle = await open(resolved.candidatePath, 'r').catch((error) => {
      throw ioError(error, '无法打开工作区目录');
    });
    try {
      const entries = await readdir(resolved.candidatePath, { withFileTypes: true }).catch((error) => {
        throw ioError(error, '无法读取工作区目录');
      });
      const canonicalPath = await this.verifyHandle(resolved, handle, 'directory');
      return { canonicalPath, entries };
    } finally {
      await handle.close();
    }
  }

  async resolveExisting(input: string, kind: 'file' | 'directory' | 'any' = 'any'): Promise<ResolvedPath> {
    validateRelativePath(input);
    await this.assertRootIdentity();
    const candidatePath = path.resolve(this.workspaceRoot, input);
    this.assertInside(candidatePath);
    this.assertForbiddenSegments(candidatePath);
    await this.assertNoLinkComponents(candidatePath);

    const canonicalPath = await realpath(candidatePath).catch((error) => {
      throw ioError(error, '工作区路径不存在或无法解析');
    });
    this.assertInside(canonicalPath);
    this.assertForbiddenSegments(canonicalPath);
    const pathStat = await stat(canonicalPath, { bigint: true }).catch((error) => {
      throw ioError(error, '无法读取工作区路径');
    });
    if (kind === 'file' && !pathStat.isFile()) throw new PathPolicyError('not_a_file', '目标不是普通文件');
    if (kind === 'directory' && !pathStat.isDirectory()) {
      throw new PathPolicyError('not_a_directory', '目标不是目录');
    }
    return { input, candidatePath, canonicalPath, stat: pathStat };
  }

  private async verifyHandle(
    resolved: ResolvedPath,
    handle: FileHandle,
    kind: 'file' | 'directory',
  ): Promise<string> {
    const handleStat = await handle.stat({ bigint: true }).catch((error) => {
      throw ioError(error, '无法读取已打开句柄');
    });
    if (kind === 'file' && !handleStat.isFile()) throw new PathPolicyError('not_a_file', '已打开目标不是普通文件');
    if (kind === 'directory' && !handleStat.isDirectory()) {
      throw new PathPolicyError('not_a_directory', '已打开目标不是目录');
    }

    await this.options.afterHandleOpen?.({
      input: resolved.input,
      candidatePath: resolved.candidatePath,
      canonicalPath: resolved.canonicalPath,
      kind,
    });
    await this.assertRootIdentity();
    await this.assertNoLinkComponents(resolved.candidatePath);
    const finalPath = await realpath(resolved.candidatePath).catch((error) => {
      throw ioError(error, '打开后无法重新解析目标路径');
    });
    this.assertInside(finalPath);
    this.assertForbiddenSegments(finalPath);
    const finalStat = await stat(finalPath, { bigint: true }).catch((error) => {
      throw ioError(error, '打开后无法读取目标路径');
    });
    if (!sameIdentity(identity(handleStat), identity(finalStat))) {
      throw new PathPolicyError('handle_identity_mismatch', '路径在检查和打开之间发生变化');
    }
    return finalPath;
  }

  private async verifyNewHandle(input: string, candidatePath: string, handle: FileHandle): Promise<string> {
    const handleStat = await handle.stat({ bigint: true }).catch((error) => {
      throw ioError(error, '无法读取新建文件句柄');
    });
    if (!handleStat.isFile()) throw new PathPolicyError('not_a_file', '新建目标不是普通文件');
    await this.assertRootIdentity();
    const parentPath = path.dirname(candidatePath);
    await this.assertNoLinkComponents(parentPath);
    const canonicalPath = await realpath(candidatePath).catch((error) => {
      throw ioError(error, '新建后无法解析目标路径');
    });
    this.assertInside(canonicalPath);
    this.assertForbiddenSegments(canonicalPath);
    const finalStat = await stat(canonicalPath, { bigint: true }).catch((error) => {
      throw ioError(error, '新建后无法读取目标路径');
    });
    if (!sameIdentity(identity(handleStat), identity(finalStat))) {
      throw new PathPolicyError('handle_identity_mismatch', `文件在创建期间发生变化：${input}`);
    }
    return canonicalPath;
  }

  private async assertRootIdentity(): Promise<void> {
    const current = await stat(this.workspaceRoot, { bigint: true }).catch((error) => {
      throw ioError(error, '工作区根目录不可用');
    });
    if (!sameIdentity(this.rootIdentity, identity(current))) {
      throw new PathPolicyError('workspace_changed', '工作区根目录在运行期间发生变化');
    }
  }

  private async assertNoLinkComponents(candidatePath: string): Promise<void> {
    const relative = path.relative(this.workspaceRoot, candidatePath);
    if (!relative) return;
    let current = this.workspaceRoot;
    for (const segment of relative.split(path.sep).filter(Boolean)) {
      current = path.join(current, segment);
      const component = await lstat(current, { bigint: true }).catch((error) => {
        throw ioError(error, '无法检查路径组件');
      });
      if (component.isSymbolicLink()) {
        throw new PathPolicyError('reparse_point_denied', '拒绝跟随符号链接或 Junction');
      }
    }
  }

  private assertInside(candidatePath: string): void {
    const root = comparablePath(this.workspaceRoot);
    const candidate = comparablePath(path.resolve(candidatePath));
    if (candidate !== root && !candidate.startsWith(`${root}${path.sep}`)) {
      throw new PathPolicyError('path_outside_workspace', '目标路径位于工作区之外');
    }
  }

  private assertForbiddenSegments(candidatePath: string): void {
    const relative = path.relative(this.workspaceRoot, candidatePath);
    const segments = relative.split(path.sep).filter(Boolean);
    if (segments.some((segment) => segment.toLowerCase() === '.git')) {
      throw new PathPolicyError('git_metadata_denied', '拒绝访问 .git 内部目录');
    }
    if (segments.some((segment) => segment.toLowerCase() === '.echolens')) {
      throw new PathPolicyError('private_metadata_denied', '拒绝访问 .echolens 私有运行目录');
    }
  }
}

export function validateRelativePath(input: string): void {
  if (typeof input !== 'string' || input.length === 0 || input.includes('\0')) {
    throw new PathPolicyError('invalid_path', '路径必须是非空字符串且不能包含 NUL');
  }
  if (input.length > 32_000) throw new PathPolicyError('path_too_long', '路径长度超过限制');

  const windows = input.replaceAll('/', '\\');
  if (/^\\\\[?.]\\/i.test(windows) || /^\\\?\?\\/i.test(windows)) {
    throw new PathPolicyError('device_path', '拒绝 Windows 设备命名空间路径');
  }
  if (windows.startsWith('\\\\')) throw new PathPolicyError('unc_path', '拒绝 UNC 路径');
  if (/^[A-Za-z]:[^\\]/.test(windows)) {
    throw new PathPolicyError('drive_relative_path', '拒绝盘符相对路径');
  }
  if (path.win32.isAbsolute(windows) || path.posix.isAbsolute(input)) {
    throw new PathPolicyError('absolute_path', '只允许工作区相对路径');
  }

  const segments = windows.split('\\').filter(Boolean);
  for (const segment of segments) {
    if (segment === '..') throw new PathPolicyError('path_outside_workspace', '拒绝包含 .. 的路径');
    if (segment === '.') continue;
    if (segment.length > 255) throw new PathPolicyError('path_too_long', '路径组件长度超过限制');
    if (segment.includes(':')) {
      throw new PathPolicyError('alternate_data_stream', '拒绝 NTFS Alternate Data Stream');
    }
    if (/[<>"|?*]/.test(segment)) throw new PathPolicyError('invalid_path', '路径包含 Windows 非法字符');
    if (/[. ]$/.test(segment)) {
      throw new PathPolicyError('trailing_dot_or_space', '拒绝以点或空格结尾的路径组件');
    }
    if (/^[^~.]{1,6}~\d+(?:\.[^.]{0,3})?$/i.test(segment)) {
      throw new PathPolicyError('short_name', '拒绝 8.3 短文件名形态');
    }
    const baseName = segment.split('.')[0]!.toUpperCase();
    if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/.test(baseName)) {
      throw new PathPolicyError('reserved_name', '拒绝 Windows 保留设备名');
    }
    if (segment.toLowerCase() === '.git') {
      throw new PathPolicyError('git_metadata_denied', '拒绝访问 .git 内部目录');
    }
    if (segment.toLowerCase() === '.echolens') {
      throw new PathPolicyError('private_metadata_denied', '拒绝访问 .echolens 私有运行目录');
    }
  }
}

interface FileIdentity {
  dev: bigint;
  ino: bigint;
}

function identity(value: BigIntStats): FileIdentity {
  if (value.ino === 0n) {
    throw new PathPolicyError('identity_unavailable', '文件系统未提供可用的文件身份标识');
  }
  return { dev: value.dev, ino: value.ino };
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function comparablePath(value: string): string {
  const resolved = path.resolve(value).replace(/[\\/]$/, '');
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function ioError(error: unknown, message: string): PathPolicyError {
  if (error instanceof PathPolicyError) return error;
  const code = isNodeError(error) && error.code === 'ENOENT' ? 'path_not_found' : 'path_io_error';
  return new PathPolicyError(code, message);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error;
}
