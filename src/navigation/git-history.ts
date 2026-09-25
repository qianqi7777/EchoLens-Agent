import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { PathPolicy, validateRelativePath } from '../runtime/path-policy.js';

const execute = promisify(execFile);

export interface GitHistoryEntry {
  path: string;
  hash: string;
  authoredAt: string;
  author: string;
  subject: string;
}

export interface GitHistoryResult {
  entries: GitHistoryEntry[];
  truncated: boolean;
  warnings: string[];
}

export interface GitHistoryOptions {
  limit?: number;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

/** 只读、限量的 Git 历史候选信息；结果不能作为事实或权限依据。 */
export class GitHistoryProvider {
  constructor(private readonly workspaceRoot: string) {}

  async load(paths: readonly string[], options: GitHistoryOptions = {}): Promise<GitHistoryResult> {
    const limit = bounded(options.limit ?? 5, 1, 20, 'limit');
    const timeoutMs = bounded(options.timeoutMs ?? 5_000, 100, 30_000, 'timeoutMs');
    const maxOutputBytes = bounded(options.maxOutputBytes ?? 256 * 1024, 1_024, 2 * 1024 * 1024, 'maxOutputBytes');
    const policy = await PathPolicy.create(this.workspaceRoot);
    const normalizedPaths = [...new Set(paths.map((value) => normalizePath(value)))].slice(0, 20);
    for (const relativePath of normalizedPaths) {
      validateRelativePath(relativePath);
      if (relativePath.toLowerCase() === '.git' || relativePath.toLowerCase().startsWith('.git/')) throw new Error('Git 历史路径不得指向 .git');
    }
    if (normalizedPaths.length === 0) return { entries: [], truncated: false, warnings: ['没有指定历史候选路径'] };
    const entries: GitHistoryEntry[] = [];
    const warnings: string[] = [];
    let truncated = false;
    for (const relativePath of normalizedPaths) {
      try {
        const result = await execute('git', [
          'log', '--no-decorate', '--no-renames', `--max-count=${limit + 1}`,
          '--format=%H%x1f%aI%x1f%an%x1f%s%x1e', '--', relativePath,
        ], { cwd: policy.workspaceRoot, shell: false, windowsHide: true, timeout: timeoutMs, maxBuffer: maxOutputBytes });
        const parsed = parseLog(relativePath, result.stdout, limit);
        entries.push(...parsed.entries);
        truncated ||= parsed.truncated;
      } catch (error) {
        warnings.push(`Git 历史不可用（${relativePath}）：${safeMessage(error)}`);
      }
    }
    entries.sort((left, right) => right.authoredAt.localeCompare(left.authoredAt) || left.path.localeCompare(right.path));
    return { entries: entries.slice(0, limit * normalizedPaths.length), truncated, warnings: warnings.slice(0, 10) };
  }
}

function parseLog(relativePath: string, output: string, limit: number): { entries: GitHistoryEntry[]; truncated: boolean } {
  const records = output.split('\u001e').map((record) => record.trim()).filter(Boolean);
  const entries: GitHistoryEntry[] = [];
  for (const record of records) {
    const [hash, authoredAt, author, subject] = record.split('\u001f');
    if (!hash || !authoredAt || !author || subject === undefined) continue;
    entries.push({ path: relativePath, hash, authoredAt, author: author.slice(0, 120), subject: subject.slice(0, 240) });
  }
  return { entries: entries.slice(0, limit), truncated: entries.length > limit };
}

function normalizePath(value: string): string {
  return value.trim().replaceAll('\\', '/').replace(/^\.\//u, '');
}

function bounded(value: number, min: number, max: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${name} 超出范围`);
  return value;
}

function safeMessage(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error && typeof (error as { code?: unknown }).code === 'string') {
    return String((error as { code: string }).code);
  }
  return error instanceof Error ? error.message.slice(0, 160) : 'unknown';
}
