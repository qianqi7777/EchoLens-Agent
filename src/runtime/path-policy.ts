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

/**
 * 路径策略错误。
 *
 * `code` 是面向调用方的稳定错误码，`message` 仅用于人读提示；调用方应依赖 `code` 而非
 * 错误文本做分支判断，错误文本可能随版本变化。
 */
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

/**
 * 工作区路径访问的安全边界。
 *
 * 输入一律视为工作区相对路径，规范化后必须仍位于工作区之内；同时拒绝重解析点
 * （符号链接 / Junction）、UNC、设备命名空间、ADS 以及 Windows 保留路径形态。
 * 返回的 `FileHandle` 由调用方持有并负责关闭；本策略在打开与校验之间通过
 * `afterHandleOpen` 钩子比对文件身份，以检测打开后发生的路径替换。
 */
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
    // 根目录自身不能是符号链接或 Junction，否则无论解析到哪里都会偏离预期的工作区边界，
    // 后续以 realpath + dev/ino 固化的身份也会不一致，因此在入口处直接拒绝。
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
    // 固化根目录身份（dev/ino）并在每次访问时重新比对，用于检测工作区根在运行期间被替换，
    // 避免后续操作落在已被迁移到别处的目录上。
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
      // 先读入比上限多 1 字节作为探测：若文件超过上限则 bytesRead 必然大于 maxBytes；读后再次
      // stat 并与打开时比对，用于检测读取期间发生的并发追加或替换，避免一次性读入超限内容。
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
      // 与 readTextFile 共享同一套上限读取与大小复核逻辑，修改时须保持两处一致。
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
    // 先持有句柄，再重新解析路径并按 dev/ino 比对，用于检测“解析后、打开前”目标被替换的
    // rename-after-open 竞态。afterHandleOpen 钩子有意在此窗口内运行，测试借此在单线程内
    // 确定性地复现该竞态，因此该钩子先于身份复核执行。
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
    // 与 verifyHandle 相同的身份复核逻辑，但针对刚创建的文件：确保创建期间目标未被替换，
    // 避免调用方拿到的句柄指向其它文件。
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
    // realpath 会静默跟随符号链接 / Junction，因此仅校验 canonicalPath 不足以拒绝链接；
    // 必须逐段 lstat，显式拒绝中间路径组件里出现的重解析点。相对路径为空即指向工作区根，无需检查。
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
    // 用字符串前缀判断包含关系前先归一化（去尾部分隔符、Windows 统一小写），否则大小写或
    // 结尾分隔符的差异会让边界判断失真；候选路径等于工作区根时需单独放行。
    const root = comparablePath(this.workspaceRoot);
    const candidate = comparablePath(path.resolve(candidatePath));
    if (candidate !== root && !candidate.startsWith(`${root}${path.sep}`)) {
      throw new PathPolicyError('path_outside_workspace', '目标路径位于工作区之外');
    }
  }

  private assertForbiddenSegments(candidatePath: string): void {
    const relative = path.relative(this.workspaceRoot, candidatePath);
    const segments = relative.split(path.sep).filter(Boolean);
    // 在 normalize / realpath 之后再次检查 .git 与 .echolens，与 validateRelativePath 构成双层防御：
    // 前者拦原始输入，这里拦解析后的路径，防止通过大小写变体或解析结果绕过。
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

  // 将 / 统一归一化为 \，使后续校验全部按 Windows 路径规则分析；工具输入允许同时使用两种
  // 分隔符，以兼容 Linux/Windows 两种工作区习惯。
  const windows = input.replaceAll('/', '\\');
  // \\?\ 与 \\.\ 是 Windows 设备命名空间，可绕过路径规范化并引用任意卷或设备；UNC 前缀指向
  // 网络共享，既超出工作区也不可本地信任。二者都在进入路径解析前拒绝。
  if (/^\\\\[?.]\\/i.test(windows) || /^\\\?\?\\/i.test(windows)) {
    throw new PathPolicyError('device_path', '拒绝 Windows 设备命名空间路径');
  }
  if (windows.startsWith('\\\\')) throw new PathPolicyError('unc_path', '拒绝 UNC 路径');
  // C:relative 是盘符相对路径，会基于当前进程驱动器解析到工作区之外，故拒绝。
  if (/^[A-Za-z]:[^\\]/.test(windows)) {
    throw new PathPolicyError('drive_relative_path', '拒绝盘符相对路径');
  }
  // 同时用 win32 与 posix 判断绝对路径：输入可能符合任意一方语义，必须双重覆盖。
  if (path.win32.isAbsolute(windows) || path.posix.isAbsolute(input)) {
    throw new PathPolicyError('absolute_path', '只允许工作区相对路径');
  }

  // 以下按组件逐一校验，覆盖 NTFS 特有的 ADS、8.3 短名、保留设备名与元数据目录等形态。
  const segments = windows.split('\\').filter(Boolean);
  for (const segment of segments) {
    if (segment === '..') throw new PathPolicyError('path_outside_workspace', '拒绝包含 .. 的路径');
    if (segment === '.') continue;
    if (segment.length > 255) throw new PathPolicyError('path_too_long', '路径组件长度超过限制');
    // 冒号在 NTFS 中引入 Alternate Data Stream，可指向同一文件上的隐藏数据流。
    if (segment.includes(':')) {
      throw new PathPolicyError('alternate_data_stream', '拒绝 NTFS Alternate Data Stream');
    }
    if (/[<>"|?*]/.test(segment)) throw new PathPolicyError('invalid_path', '路径包含 Windows 非法字符');
    // 以点或空格结尾的组件会被 Windows 静默截断，8.3 短文件名（如 SOURCE~1）可遮蔽真实目录名，
    // 二者都作为潜在的绕过形态拒绝。
    if (/[. ]$/.test(segment)) {
      throw new PathPolicyError('trailing_dot_or_space', '拒绝以点或空格结尾的路径组件');
    }
    if (/^[^~.]{1,6}~\d+(?:\.[^.]{0,3})?$/i.test(segment)) {
      throw new PathPolicyError('short_name', '拒绝 8.3 短文件名形态');
    }
    const baseName = segment.split('.')[0]!.toUpperCase();
    // CON/PRN/AUX/NUL/COM1-9/LPT1-9 是 Windows 保留设备名，访问它们不会得到普通文件语义。
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
  // 部分文件系统（尤其 Windows 上某些句柄）不提供 ino；此时无法唯一标识文件身份，
  // 必须失败而不是放行，否则 dev/ino 比对会退化并失去路径替换检测能力。
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
  // Windows 文件系统大小写不敏感，比较前须归一到同一大小写，否则工作区根与候选路径的大小写
  // 差异会造成边界判断失真；POSIX 则以原始大小写比较。
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function ioError(error: unknown, message: string): PathPolicyError {
  if (error instanceof PathPolicyError) return error;
  // 将底层系统错误稳定映射：ENOENT → path_not_found，其余归为 path_io_error。调用方依赖的是
  // 稳定错误码而非系统错误文本，因此不对外承诺底层 errno 的稳定性。
  const code = isNodeError(error) && error.code === 'ENOENT' ? 'path_not_found' : 'path_io_error';
  return new PathPolicyError(code, message);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error;
}
