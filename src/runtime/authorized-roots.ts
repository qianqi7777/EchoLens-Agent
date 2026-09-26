import { lstat, readFile, realpath } from 'node:fs/promises';
import * as path from 'node:path';

export interface AuthorizedRoot {
  canonicalPath: string;
  allowWrite: boolean;
  note?: string;
}

export interface AuthorizedRootsResult {
  roots: AuthorizedRoot[];
  warnings: string[];
}

interface RootConfigEntry {
  path?: unknown;
  allowWrite?: unknown;
  note?: unknown;
}

const MAX_CONFIG_BYTES = 64 * 1024;
const MAX_ROOTS = 16;

/**
 * 读取仅由用户控制的工作区外授权根配置。
 * 项目规则文件不会进入此路径；任何格式、权限、符号链接或真实路径校验失败都只会
 * 产生 warning 并跳过该根，绝不扩大访问范围。
 */
export async function loadAuthorizedRoots(workspaceRoot: string): Promise<AuthorizedRootsResult> {
  const privateDirectory = path.join(path.resolve(workspaceRoot), '.echolens');
  const configPath = path.join(privateDirectory, 'roots.json');
  let source: Buffer;
  try {
    const directoryStat = await lstat(privateDirectory);
    if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
      return { roots: [], warnings: ['.echolens 配置目录不是普通目录，已忽略授权根'] };
    }
    const configStat = await lstat(configPath);
    if (configStat.isSymbolicLink() || !configStat.isFile()) {
      return { roots: [], warnings: ['授权根配置不是普通文件，已忽略'] };
    }
    if (configStat.size > MAX_CONFIG_BYTES) return { roots: [], warnings: ['授权根配置超过大小上限，已忽略'] };
    source = await readFile(configPath);
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return { roots: [], warnings: [] };
    return { roots: [], warnings: ['授权根配置无法读取，已忽略'] };
  }

  let value: unknown;
  try { value = JSON.parse(source.toString('utf8')); }
  catch { return { roots: [], warnings: ['授权根配置不是有效 JSON，已忽略'] }; }
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.roots)) {
    return { roots: [], warnings: ['授权根配置 Schema 无效，已忽略'] };
  }

  const roots: AuthorizedRoot[] = [];
  const warnings: string[] = [];
  for (const [index, entry] of value.roots.slice(0, MAX_ROOTS).entries()) {
    const result = await normalizeRoot(entry as RootConfigEntry, workspaceRoot);
    if (result.root) roots.push(result.root);
    if (result.warning) warnings.push(`授权根[${index}]：${result.warning}`);
  }
  if (value.roots.length > MAX_ROOTS) warnings.push(`授权根数量超过 ${MAX_ROOTS}，多余项已忽略`);
  const unique = new Map<string, AuthorizedRoot>();
  for (const root of roots) unique.set(comparable(root.canonicalPath), root);
  return { roots: [...unique.values()], warnings };
}

async function normalizeRoot(entry: RootConfigEntry, workspaceRoot: string): Promise<{ root?: AuthorizedRoot; warning?: string }> {
  if (!isRecord(entry) || typeof entry.path !== 'string' || typeof entry.allowWrite !== 'boolean') {
    return { warning: '必须提供绝对 path 与 boolean allowWrite' };
  }
  if (!path.isAbsolute(entry.path) || entry.path.includes('\0')) return { warning: 'path 必须是绝对路径且不能包含 NUL' };
  if (typeof entry.note === 'string' && entry.note.length > 500) return { warning: 'note 超过 500 字符' };
  const requested = path.resolve(entry.path);
  try {
    const link = await lstat(requested);
    if (link.isSymbolicLink() || !link.isDirectory()) return { warning: '授权根必须是普通目录，不能是符号链接或 Junction' };
    const canonical = await realpath(requested);
    const workspaceCanonical = await realpath(path.resolve(workspaceRoot));
    if (isWithin(workspaceCanonical, canonical)) return { warning: '已位于工作区内，无需配置为额外根' };
    return {
      root: {
        canonicalPath: canonical,
        allowWrite: entry.allowWrite,
        ...(typeof entry.note === 'string' && entry.note ? { note: entry.note } : {}),
      },
    };
  } catch (error) {
    return { warning: isNodeError(error, 'ENOENT') ? '目录不存在' : '目录无法规范化或读取' };
  }
}

export function comparable(value: string): string {
  const normalized = path.resolve(value).replace(/[\\/]+$/u, '');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

export function isWithin(root: string, candidate: string): boolean {
  const base = comparable(root);
  const value = comparable(candidate);
  return value === base || value.startsWith(`${base}${path.sep}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === code;
}
