import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { lstat } from 'node:fs/promises';
import { PathPolicy, PathPolicyError } from '../runtime/path-policy.js';
import type { Permission } from '../core/permissions.js';
import type { ToolRegistry } from '../runtime/tool-registry.js';
import { parseManifest, type SkillManifest } from './skill-manager.js';

export type SkillSource = 'builtin' | 'user' | 'project';

export interface SkillCatalogEntry {
  name: string;
  description: string;
  source: SkillSource;
  path: string;
  allowedTools?: string[];
}

export interface LoadedSkill extends SkillCatalogEntry {
  body: string;
  references: string[];
  scripts: string[];
}

export interface SkillLoaderOptions {
  workspaceRoot: string;
  userSkillRoot?: string;
  builtinSkillRoot?: string;
  toolRegistry?: ToolRegistry;
  allowedPermissions?: ReadonlySet<Permission>;
  maxCatalogTokens?: number;
}

export interface SkillCatalogResult {
  entries: SkillCatalogEntry[];
  warnings: string[];
}

interface SkillRecord extends SkillCatalogEntry {
  root: string;
  relativeDirectory: string;
}

const SOURCE_ORDER: readonly SkillSource[] = ['project', 'user', 'builtin'];
const DEFAULT_MAX_CATALOG_TOKENS = 512;

/**
 * 发现并按优先级加载 Agent Skills。文件读取始终通过 PathPolicy，
 * 因此 references/scripts 即使来自用户目录或内置目录也不能逃出其授权根。
 */
export class SkillLoader {
  private readonly workspaceRoot: string;
  private readonly roots: Record<SkillSource, string>;
  private readonly toolRegistry?: ToolRegistry;
  private readonly allowedPermissions: ReadonlySet<Permission>;
  private readonly maxCatalogTokens: number;

  constructor(options: SkillLoaderOptions) {
    this.workspaceRoot = resolve(options.workspaceRoot);
    this.roots = {
      project: resolve(this.workspaceRoot, '.echolens', 'skills'),
      user: resolve(options.userSkillRoot ?? process.env.ECHOLENS_HOME ?? join(homedir(), '.echolens'), 'skills'),
      builtin: resolve(options.builtinSkillRoot ?? join(dirname(fileURLToPath(import.meta.url)), 'builtin')),
    };
    this.toolRegistry = options.toolRegistry;
    this.allowedPermissions = options.allowedPermissions ?? new Set<Permission>();
    this.maxCatalogTokens = options.maxCatalogTokens ?? DEFAULT_MAX_CATALOG_TOKENS;
  }

  async catalog(options: { maxTokens?: number; query?: string } = {}): Promise<SkillCatalogResult> {
    const warnings: string[] = [];
    const records = new Map<string, SkillRecord>();
    for (const source of SOURCE_ORDER) {
      const discovered = await this.discoverRoot(source, warnings);
      for (const record of discovered) if (!records.has(record.name)) records.set(record.name, record);
    }
    const entries = [...records.values()].sort((left, right) => {
      const relevance = (options.query ? scoreEntry(right, options.query) - scoreEntry(left, options.query) : 0);
      return relevance || left.name.localeCompare(right.name);
    });
    const maxTokens = options.maxTokens ?? this.maxCatalogTokens;
    let used = 0;
    const selected: SkillCatalogEntry[] = [];
    for (const entry of entries) {
      const cost = estimateCatalogTokens(entry);
      if (selected.length > 0 && used + cost > maxTokens) break;
      selected.push(publicEntry(entry));
      used += cost;
    }
    if (selected.length < entries.length) warnings.push(`Skill catalog 已按 ${maxTokens} token 预算截断`);
    return { entries: selected, warnings };
  }

  async load(name: string): Promise<LoadedSkill> {
    const result = await this.catalog({ maxTokens: Number.MAX_SAFE_INTEGER });
    const record = await this.findRecord(name, result.entries);
    if (!record) throw new Error(`未找到 Skill：${name}`);
    const policy = await PathPolicy.create(record.root);
    const prefix = record.relativeDirectory ? `${record.relativeDirectory}/` : '';
    const entry = await policy.readTextFile(`${prefix}SKILL.md`);
    const references = await listDirectFiles(policy, `${prefix}references`, 'references');
    const scripts = await listDirectFiles(policy, `${prefix}scripts`, 'scripts');
    return {
      ...publicEntry(record),
      body: stripFrontmatter(entry.content),
      references,
      scripts,
    };
  }

  /** 读取已加载 Skill 的 references 文件，路径不能离开 references 根。 */
  async readReference(skill: LoadedSkill | SkillCatalogEntry, name: string): Promise<string> {
    const record = await this.recordForEntry(skill);
    const relativeName = safeChild(name.startsWith('references/') ? name.slice('references/'.length) : name);
    const policy = await PathPolicy.create(record.root);
    const prefix = record.relativeDirectory ? `${record.relativeDirectory}/` : '';
    return (await policy.readTextFile(`${prefix}references/${relativeName}`)).content;
  }

  private async recordForEntry(entry: SkillCatalogEntry): Promise<SkillRecord> {
    const records = await this.allRecords([]);
    const record = records.find((item) => item.name === entry.name && item.path === entry.path);
    if (!record) throw new Error(`Skill 不属于当前 catalog：${entry.name}`);
    return record;
  }

  private async findRecord(name: string, entries: readonly SkillCatalogEntry[]): Promise<SkillRecord | undefined> {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(name)) return undefined;
    const records = await this.allRecords([]);
    const selected = records.find((item) => item.name === name);
    return selected && entries.some((entry) => entry.name === selected.name && entry.path === selected.path)
      ? selected : undefined;
  }

  private async allRecords(warnings: string[]): Promise<SkillRecord[]> {
    const records = new Map<string, SkillRecord>();
    for (const source of SOURCE_ORDER) {
      for (const record of await this.discoverRoot(source, warnings)) {
        if (!records.has(record.name)) records.set(record.name, record);
      }
    }
    return [...records.values()];
  }

  private async discoverRoot(source: SkillSource, warnings: string[]): Promise<SkillRecord[]> {
    const root = this.roots[source];
    const rootStat = await lstat(root).catch(() => undefined);
    if (!rootStat) return [];
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      warnings.push(`Skill 根目录被拒绝：${root}`);
      return [];
    }
    let policy: PathPolicy;
    try { policy = await PathPolicy.create(root); }
    catch (error) { warnings.push(`Skill 根目录不可用：${root}（${messageOf(error)}）`); return []; }
    let directory;
    try { directory = await policy.readDirectory('.'); }
    catch (error) { warnings.push(`Skill 目录无法读取：${root}（${messageOf(error)}）`); return []; }
    const records: SkillRecord[] = [];
    for (const child of directory.entries) {
      if (!child.isDirectory() || child.isSymbolicLink()) continue;
      const relativeDirectory = child.name;
      const entryRelative = `${relativeDirectory}/SKILL.md`;
      try {
        const entry = await policy.readTextFile(entryRelative);
        const manifest = parseManifest(entry.content, basename(relativeDirectory), { strict: true });
        const allowedTools = this.sanitizeAllowedTools(manifest, warnings, `${source}/${relativeDirectory}`);
        records.push({
          name: manifest.name,
          description: manifest.description!,
          source,
          path: resolve(root, relativeDirectory),
          allowedTools,
          root,
          relativeDirectory,
        });
      } catch (error) {
        warnings.push(`跳过非法 Skill ${source}/${relativeDirectory}：${messageOf(error)}`);
      }
    }
    return records;
  }

  private sanitizeAllowedTools(manifest: SkillManifest, warnings: string[], label: string): string[] | undefined {
    if (!manifest.allowedTools) return undefined;
    if (!this.toolRegistry) {
      warnings.push(`Skill ${label} 的 allowed-tools 已降级为空：运行时未提供 ToolRegistry`);
      return [];
    }
    const known = new Set(this.toolRegistry.list().map((tool) => tool.name));
    const accepted = manifest.allowedTools.filter((name) => {
      if (!known.has(name)) { warnings.push(`Skill ${label} 的工具声明被拒绝：未知工具 ${name}`); return false; }
      const tool = this.toolRegistry!.get(name);
      if (!this.allowedPermissions.has(tool.permission)) {
        warnings.push(`Skill ${label} 的工具声明被拒绝：权限未获授权 ${name}`);
        return false;
      }
      return true;
    });
    return accepted;
  }
}

function publicEntry(record: SkillRecord): SkillCatalogEntry {
  return { name: record.name, description: record.description, source: record.source, path: record.path, ...(record.allowedTools ? { allowedTools: [...record.allowedTools] } : {}) };
}

function estimateCatalogTokens(entry: SkillCatalogEntry): number {
  return Math.max(1, Math.ceil(Buffer.byteLength(`${entry.name}: ${entry.description}\n`, 'utf8') / 4));
}

function scoreEntry(entry: SkillCatalogEntry, query: string): number {
  const terms = query.toLowerCase().split(/[^a-z0-9\u4e00-\u9fff]+/u).filter((term) => term.length >= 2);
  const haystack = `${entry.name} ${entry.description}`.toLowerCase();
  return terms.reduce((score, term) => score + (haystack.includes(term) ? 1 : 0), 0);
}

async function listDirectFiles(policy: PathPolicy, relativeDirectory: string, label: string): Promise<string[]> {
  try {
    const directory = await policy.readDirectory(relativeDirectory);
    return directory.entries.filter((entry) => entry.isFile() && !entry.isSymbolicLink()).map((entry) => `${label}/${entry.name}`).sort();
  } catch (error) {
    if (error instanceof PathPolicyError && (error.code === 'path_not_found' || error.code === 'not_a_directory')) return [];
    throw new Error(`${label} 目录读取失败：${messageOf(error)}`);
  }
}

function safeChild(value: string): string {
  if (!value || value.includes('/') || value.includes('\\') || value === '.' || value === '..' || value.includes('..')) {
    throw new Error('references 路径无效');
  }
  return value;
}

function stripFrontmatter(content: string): string {
  return content.replace(/^---\s*\r?\n[\s\S]*?\r?\n---\s*\r?\n/u, '').trimStart();
}

function messageOf(error: unknown): string { return error instanceof Error ? error.message : String(error); }
