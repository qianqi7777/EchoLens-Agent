import { cp, lstat, mkdir, readFile, realpath, rm } from 'node:fs/promises';
import { basename, dirname, resolve, join } from 'node:path';
export interface SkillManifest {
  name: string;
  description?: string;
  allowedTools?: string[];
  compatibility?: string;
  license?: string;
  metadata?: Record<string, string>;
}
export interface ImportedSkill extends SkillManifest { sourcePath: string; destinationPath: string; entrypoint: string }
export interface SkillImportOptions { workspaceRoot: string; maxBytes?: number }
const DEFAULT_MAX_BYTES = 512 * 1024;
export class SkillManager {
  private readonly workspaceRoot: string; private readonly maxBytes: number;
  constructor(options: SkillImportOptions) { this.workspaceRoot = resolve(options.workspaceRoot); this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES; }
  async import(source: string): Promise<ImportedSkill> {
    const requested = resolve(this.workspaceRoot, source); const sourceStat = await lstat(requested).catch(() => undefined);
    if (!sourceStat) throw new Error(`Skill 路径不存在：${source}`);
    const sourceDirectory = sourceStat.isDirectory() ? requested : dirname(requested); const entrypoint = join(sourceDirectory, 'SKILL.md');
    const entryStat = await lstat(entrypoint).catch(() => undefined); if (!entryStat?.isFile()) throw new Error('Skill 必须包含 SKILL.md 文件');
    if (entryStat.isSymbolicLink()) throw new Error('不允许使用符号链接作为 SKILL.md');
    const content = await readFile(entrypoint, 'utf8'); if (Buffer.byteLength(content, 'utf8') > this.maxBytes) throw new Error('SKILL.md 超出大小限制');
    const manifest = parseManifest(content, basename(sourceDirectory), { strict: true }); const destinationRoot = resolve(this.workspaceRoot, '.echolens', 'skills'); const destination = join(destinationRoot, manifest.name);
    if ((await realpath(sourceDirectory)) === resolve(destination)) throw new Error('不能把 Skill 导入自身目录');
    await mkdir(destinationRoot, { recursive: true }); await rm(destination, { recursive: true, force: true });
    await cp(sourceDirectory, destination, { recursive: true, dereference: false, errorOnExist: false });
    return { ...manifest, sourcePath: await realpath(sourceDirectory), destinationPath: destination, entrypoint: join(destination, 'SKILL.md') };
  }
}
export interface ParseManifestOptions { strict?: boolean }

/** 解析 Agent Skills 的 YAML frontmatter。未知字段有意忽略，以保持前向兼容。 */
export function parseManifest(content: string, fallbackName: string, options: ParseManifestOptions = {}): SkillManifest {
  const match = content.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n/u);
  if (options.strict && !match) throw new Error('Skill 必须包含 frontmatter');
  const fields = new Map<string, string>();
  const listFields = new Map<string, string[]>();
  let currentList: string | undefined;
  for (const line of (match?.[1] ?? '').split(/\r?\n/u)) {
    const listItem = line.match(/^\s*-\s*(.+)\s*$/u);
    if (listItem && currentList) {
      listFields.set(currentList, [...(listFields.get(currentList) ?? []), unquote(listItem[1]!.trim())]);
      continue;
    }
    const separator = line.indexOf(':');
    if (separator < 1) continue;
    const key = line.slice(0, separator).trim();
    const value = unquote(line.slice(separator + 1).trim());
    currentList = key === 'allowed-tools' ? key : undefined;
    if (value) fields.set(key, value);
    if (key === 'allowed-tools' && value) {
      listFields.set(key, value.replace(/^\[|\]$/gu, '').split(/[,\s]+/u).filter(Boolean));
    }
  }
  const rawName = fields.get('name') || (options.strict ? '' : fallbackName);
  if (!rawName) throw new Error('Skill 缺少 name');
  const name = options.strict
    ? rawName
    : rawName.toLowerCase().replace(/[^a-z0-9-]+/gu, '-').replace(/^-+|-+$/gu, '').slice(0, 64);
  if (!/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u.test(name) || name.includes('--')) {
    throw new Error('Skill 名称必须是小写字母、数字与单连字符，长度不超过 64');
  }
  const description = fields.get('description');
  if (options.strict) {
    if (!description) throw new Error('Skill 缺少 description');
    if (description.length > 1024) throw new Error('Skill description 超过 1024 字符');
    if ((fields.get('compatibility')?.length ?? 0) > 500) throw new Error('Skill compatibility 超过 500 字符');
    if (!describesWhat(description) || !describesWhen(description)) {
      throw new Error('Skill description 必须同时说明做什么与什么时候使用');
    }
    if (name !== fallbackName) throw new Error('Skill name 必须与父目录名一致');
  }
  const result: SkillManifest = { name, description: description || undefined };
  const allowedTools = listFields.get('allowed-tools');
  if (allowedTools?.length) result.allowedTools = allowedTools;
  if (fields.has('compatibility')) result.compatibility = fields.get('compatibility');
  if (fields.has('license')) result.license = fields.get('license');
  return result;
}

function unquote(value: string): string { return value.replace(/^['"]|['"]$/gu, ''); }
function describesWhen(value: string): boolean { return /\b(?:when|whenever|if|during|for)\b|当|在.+时|用于|适合|触发/u.test(value); }
function describesWhat(value: string): boolean { return /\b(?:search|run|test|review|manage|find|analy[sz]e|edit|git)\b|帮助|执行|查找|管理|分析|编辑|搜索|测试/u.test(value); }
