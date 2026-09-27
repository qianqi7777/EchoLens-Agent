import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { mkdir, lstat } from 'node:fs/promises';
import { PathPolicy, PathPolicyError } from '../runtime/path-policy.js';

export interface AgentMemoryOptions {
  homeDirectory?: string;
  maxLines?: number;
  maxBytes?: number;
}

export interface AgentMemoryReadResult {
  content: string;
  truncated: boolean;
  warning?: string;
}

export interface AgentMemoryWriteResult {
  bytes: number;
  lines: number;
}

const MEMORY_FILE = 'memory.md';

/** 子 Agent 记忆存储：只允许规范化 profile 目录，读写均经 PathPolicy。 */
export class AgentMemoryStore {
  private readonly root: string;
  private readonly maxLines: number;
  private readonly maxBytes: number;

  constructor(options: AgentMemoryOptions = {}) {
    this.root = resolve(options.homeDirectory ?? process.env.ECHOLENS_HOME ?? join(homedir(), '.echolens'), 'agent-memory');
    this.maxLines = options.maxLines ?? 200;
    this.maxBytes = options.maxBytes ?? 64 * 1024;
    if (!Number.isInteger(this.maxLines) || this.maxLines < 1 || this.maxLines > 10_000) throw new Error('Agent memory 行数上限无效');
    if (!Number.isInteger(this.maxBytes) || this.maxBytes < 256 || this.maxBytes > 4 * 1024 * 1024) throw new Error('Agent memory 大小上限无效');
  }

  async read(profile: string): Promise<AgentMemoryReadResult> {
    const directory = await this.profileDirectory(profile);
    const policy = await PathPolicy.create(directory);
    let content: string;
    try { content = (await policy.readTextFile(MEMORY_FILE, this.maxBytes)).content; }
    catch (error) {
      if (error instanceof PathPolicyError && error.code === 'path_not_found') return { content: '', truncated: false };
      throw error;
    }
    const lines = content.split(/\r?\n/u);
    const truncated = lines.length > this.maxLines;
    return {
      content: (truncated ? lines.slice(0, this.maxLines) : lines).join('\n'),
      truncated,
      ...(truncated ? { warning: `记忆已截取前 ${this.maxLines} 行` } : {}),
    };
  }

  async write(profile: string, content: string): Promise<AgentMemoryWriteResult> {
    const bytes = Buffer.byteLength(content, 'utf8');
    if (bytes > this.maxBytes) throw new Error(`Agent memory 超过 ${this.maxBytes} bytes，拒绝写入`);
    const directory = await this.profileDirectory(profile);
    const policy = await PathPolicy.create(directory);
    const handle = await policy.openFileForWrite(MEMORY_FILE).catch(async (error) => {
      if (error instanceof PathPolicyError && error.code === 'path_not_found') return policy.createFile(MEMORY_FILE);
      throw error;
    });
    try {
      await handle.handle.truncate(0);
      await handle.handle.writeFile(content, 'utf8');
    } finally {
      await handle.handle.close();
    }
    return { bytes, lines: content ? content.split(/\r?\n/u).length : 0 };
  }

  async append(profile: string, content: string): Promise<AgentMemoryWriteResult> {
    const current = await this.read(profile);
    const next = current.content ? `${current.content}\n${content}` : content;
    return this.write(profile, next);
  }

  private async profileDirectory(profile: string): Promise<string> {
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/iu.test(profile) || profile.includes('..')) throw new Error('Agent memory profile 无效');
    await mkdir(this.root, { recursive: true });
    const rootStat = await lstat(this.root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('Agent memory 根目录无效');
    const directory = join(this.root, profile);
    await mkdir(directory, { recursive: true });
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Agent memory profile 目录无效');
    return directory;
  }
}
