import { cp, lstat, mkdir, readFile, realpath, rm } from 'node:fs/promises';
import { basename, dirname, resolve, join } from 'node:path';
export interface SkillManifest { name: string; description?: string }
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
    const manifest = parseManifest(content, basename(sourceDirectory)); const destinationRoot = resolve(this.workspaceRoot, '.echolens', 'skills'); const destination = join(destinationRoot, manifest.name);
    if ((await realpath(sourceDirectory)) === resolve(destination)) throw new Error('不能把 Skill 导入自身目录');
    await mkdir(destinationRoot, { recursive: true }); await rm(destination, { recursive: true, force: true });
    await cp(sourceDirectory, destination, { recursive: true, dereference: false, errorOnExist: false });
    return { ...manifest, sourcePath: await realpath(sourceDirectory), destinationPath: destination, entrypoint: join(destination, 'SKILL.md') };
  }
}
export function parseManifest(content: string, fallbackName: string): SkillManifest {
  const match = content.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n/u); const fields = new Map<string, string>();
  for (const line of (match?.[1] ?? '').split(/\r?\n/u)) { const separator = line.indexOf(':'); if (separator < 1) continue; fields.set(line.slice(0, separator).trim(), line.slice(separator + 1).trim().replace(/^['"]|['"]$/gu, '')); }
  const rawName = fields.get('name') || fallbackName; const name = rawName.toLowerCase().replace(/[^a-z0-9._-]+/gu, '-').replace(/^-+|-+$/gu, '').slice(0, 64); if (!name) throw new Error('Skill 名称无效');
  return { name, description: fields.get('description') || undefined };
}
