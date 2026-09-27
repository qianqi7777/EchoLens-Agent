import { createHash } from 'node:crypto';
import { createTwoFilesPatch, FILE_HEADERS_ONLY } from 'diff';
import { loadEditCheckpoint } from './structured-patch.js';

export interface ChangeSetFile {
  path: string;
  beforeExisted: boolean;
  afterExisted: boolean;
  beforeHash?: string;
  afterHash?: string;
  diff: string;
}

export interface ChangeSet {
  version: 1;
  workspaceRoot: string;
  turnId?: string;
  checkpointIds: string[];
  files: ChangeSetFile[];
  verification?: { status: 'passed' | 'failed' | 'skipped'; issueCount: number };
  diff: string;
  truncated: boolean;
}

interface FileState {
  before?: Buffer;
  after?: Buffer;
  beforeExisted: boolean;
  afterExisted: boolean;
  beforeHash?: string;
  afterHash?: string;
}

/** Reconstructs the net patch solely from the bytes saved with each edit checkpoint. */
export async function buildChangeSet(
  workspaceRoot: string,
  checkpointIds: readonly string[],
  options: { maxChars?: number; file?: string } = {},
): Promise<ChangeSet> {
  const maxChars = options.maxChars ?? 200_000;
  if (!Number.isSafeInteger(maxChars) || maxChars < 128 || maxChars > 2_000_000) {
    throw new Error('变更包字符上限无效');
  }
  const ids = [...new Set(checkpointIds)];
  if (ids.length > 256) throw new Error('变更包 checkpoint 数量超限');
  const states = new Map<string, FileState>();
  let canonicalRoot: string | undefined;
  for (const id of ids) {
    const checkpoint = await loadEditCheckpoint(workspaceRoot, id);
    canonicalRoot ??= checkpoint.workspaceRoot;
    if (checkpoint.workspaceRoot !== canonicalRoot) throw new Error('变更包包含不同工作区的 checkpoint');
    for (const file of checkpoint.files) {
      if (file.afterExisted === undefined) throw new Error(`旧 checkpoint 缺少补丁后内容：${id}`);
      const before = file.existed ? decode(file.contentBase64, file.hash, id) : undefined;
      const after = file.afterExisted ? decode(file.afterContentBase64, file.afterHash, id) : undefined;
      const previous = states.get(file.path);
      if (previous) {
        if (previous.afterExisted !== file.existed || !sameBytes(previous.after, before)) {
          throw new Error(`checkpoint 链不连续：${file.path}`);
        }
        previous.after = after;
        previous.afterExisted = file.afterExisted;
        previous.afterHash = file.afterHash;
      } else {
        states.set(file.path, {
          before, after, beforeExisted: file.existed, afterExisted: file.afterExisted,
          beforeHash: file.hash, afterHash: file.afterHash,
        });
      }
    }
  }
  if (options.file && !states.has(options.file)) throw new Error(`变更包中没有文件：${options.file}`);
  const files = [...states.entries()]
    .filter(([path]) => !options.file || path === options.file)
    .map(([path, state]): ChangeSetFile => ({
      path,
      beforeExisted: state.beforeExisted,
      afterExisted: state.afterExisted,
      beforeHash: state.beforeHash,
      afterHash: state.afterHash,
      diff: state.beforeExisted === state.afterExisted && sameBytes(state.before, state.after)
        ? ''
        : createTwoFilesPatch(
            state.beforeExisted ? `a/${path}` : '/dev/null',
            state.afterExisted ? `b/${path}` : '/dev/null',
            state.before?.toString('utf8') ?? '', state.after?.toString('utf8') ?? '',
            undefined, undefined, { context: 3, headerOptions: FILE_HEADERS_ONLY },
          ),
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
  const fullDiff = files.map((file) => file.diff).filter(Boolean).join('\n');
  const truncated = fullDiff.length > maxChars;
  return {
    version: 1,
    workspaceRoot: canonicalRoot ?? workspaceRoot,
    checkpointIds: ids,
    files,
    diff: truncated ? `${fullDiff.slice(0, maxChars - 18)}\n[diff truncated]` : fullDiff,
    truncated,
  };
}

function decode(encoded: string | undefined, expectedHash: string | undefined, id: string): Buffer {
  if (encoded === undefined || expectedHash === undefined) throw new Error(`checkpoint 内容不完整：${id}`);
  const bytes = Buffer.from(encoded, 'base64');
  const actualHash = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  if (actualHash !== expectedHash) throw new Error(`checkpoint 内容哈希不匹配：${id}`);
  return bytes;
}

function sameBytes(left: Buffer | undefined, right: Buffer | undefined): boolean {
  if (!left || !right) return !left && !right;
  return left.equals(right);
}
