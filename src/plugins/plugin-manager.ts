import { copyFile, lstat, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import * as path from 'node:path';

export interface PluginManifest {
  version: 1;
  name: string;
  components: Array<'skills' | 'hooks' | 'subagents' | 'mcp'>;
}

export interface PluginBundle extends PluginManifest {
  path: string;
}

const NAME = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u;
const FORBIDDEN = /^(?:AGENTS\.md|\.env(?:\..*)?|studydocs?|\.git|\.echolens)$/iu;

/** 受限的工作区插件分发目录：只收集公开 Skill/Hook/Subagent/MCP 配置。 */
export class PluginManager {
  private readonly root: string;
  private readonly bundleRoot: string;

  constructor(workspaceRoot: string) {
    this.root = path.resolve(workspaceRoot);
    this.bundleRoot = path.join(this.root, '.echolens', 'plugins');
  }

  async list(): Promise<PluginBundle[]> {
    const entries = await readdir(this.bundleRoot, { withFileTypes: true }).catch(() => []);
    const result: PluginBundle[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      try {
        const manifest = JSON.parse(await readFile(path.join(this.bundleRoot, entry.name, 'plugin.json'), 'utf8')) as PluginManifest;
        validateManifest(manifest, entry.name);
        result.push({ ...manifest, path: path.join(this.bundleRoot, entry.name) });
      } catch { /* 不可信包不进入列表，但不阻断其它包。 */ }
    }
    return result.sort((left, right) => left.name.localeCompare(right.name));
  }

  async exportBundle(name: string): Promise<PluginBundle> {
    validateName(name);
    const output = path.join(this.bundleRoot, name);
    if (await lstat(output).catch(() => undefined)) throw new Error('插件包已存在，拒绝覆盖');
    const components: PluginManifest['components'] = [];
    await mkdir(output, { recursive: true });
    const sourceRoot = path.join(this.root, '.echolens');
    const skills = path.join(sourceRoot, 'skills');
    if (await isDirectory(skills)) { await copyTree(skills, path.join(output, 'skills'), this.root); components.push('skills'); }
    const subagents = path.join(sourceRoot, 'subagents');
    if (await isDirectory(subagents)) { await copyTree(subagents, path.join(output, 'subagents'), this.root); components.push('subagents'); }
    const hooks = path.join(sourceRoot, 'hooks.json');
    if (await isRegularFile(hooks)) { await copyPublicFile(hooks, path.join(output, 'hooks.json'), this.root); components.push('hooks'); }
    const mcp = path.join(sourceRoot, 'mcp.json');
    if (await isRegularFile(mcp)) { await copyPublicFile(mcp, path.join(output, 'mcp.json'), this.root); components.push('mcp'); }
    const manifest: PluginManifest = { version: 1, name, components };
    await writeFile(path.join(output, 'plugin.json'), `${JSON.stringify(manifest, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    return { ...manifest, path: output };
  }

  async importBundle(source: string): Promise<PluginBundle> {
    const input = path.resolve(this.root, source);
    const stat = await lstat(input).catch(() => undefined);
    if (!stat?.isDirectory() || stat.isSymbolicLink()) throw new Error('插件包必须是普通目录');
    const manifest = JSON.parse(await readFile(path.join(input, 'plugin.json'), 'utf8')) as PluginManifest;
    validateManifest(manifest, path.basename(input));
    await assertTreeSafe(input);
    const output = path.join(this.bundleRoot, manifest.name);
    if (path.resolve(input) === path.resolve(output)) throw new Error('不能把插件导入自身目录');
    if (await lstat(output).catch(() => undefined)) throw new Error('插件包已存在，拒绝覆盖');
    await mkdir(this.bundleRoot, { recursive: true });
    await copyTree(input, output, undefined, new Set(['plugin.json']));
    await writeFile(path.join(output, 'plugin.json'), `${JSON.stringify(manifest, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    return { ...manifest, path: output };
  }
}

function validateManifest(value: PluginManifest, directoryName: string): void {
  if (!value || value.version !== 1 || typeof value.name !== 'string' || value.name !== directoryName) throw new Error('插件 manifest 无效');
  validateName(value.name);
  if (!Array.isArray(value.components) || value.components.some((item) => !['skills', 'hooks', 'subagents', 'mcp'].includes(item))) throw new Error('插件组件无效');
  if (new Set(value.components).size !== value.components.length) throw new Error('插件组件重复');
}
function validateName(value: string): void { if (!NAME.test(value) || FORBIDDEN.test(value)) throw new Error('插件名称无效'); }
function assertInside(root: string, candidate: string): void {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('插件路径必须位于工作区内');
}
async function isDirectory(target: string): Promise<boolean> { const stat = await lstat(target).catch(() => undefined); return Boolean(stat?.isDirectory() && !stat.isSymbolicLink()); }
async function isRegularFile(target: string): Promise<boolean> { const stat = await lstat(target).catch(() => undefined); return Boolean(stat?.isFile() && !stat.isSymbolicLink()); }
async function copyPublicFile(source: string, destination: string, root: string): Promise<void> {
  assertInside(root, source); assertInside(root, destination);
  const text = await readFile(source, 'utf8');
  if (FORBIDDEN.test(path.basename(source)) || containsSecret(text)) throw new Error(`拒绝打包敏感文件：${path.basename(source)}`);
  await mkdir(path.dirname(destination), { recursive: true }); await copyFile(source, destination);
}
async function copyTree(source: string, destination: string, root: string | undefined, skip = new Set<string>()): Promise<void> {
  if (root) { assertInside(root, source); assertInside(root, destination); }
  const entries = await readdir(source, { withFileTypes: true });
  await mkdir(destination, { recursive: true });
  for (const entry of entries) {
    if (skip.has(entry.name)) continue;
    if (FORBIDDEN.test(entry.name)) throw new Error(`拒绝打包受限路径：${entry.name}`);
    const from = path.join(source, entry.name); const to = path.join(destination, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`插件不允许符号链接：${entry.name}`);
    if (entry.isDirectory()) await copyTree(from, to, root, skip);
    else if (entry.isFile()) {
      if (entry.name !== 'plugin.json' && containsSecret(await readFile(from, 'utf8'))) throw new Error(`插件包含敏感内容：${entry.name}`);
      await copyFile(from, to);
    }
    else throw new Error(`插件包含不支持的文件：${entry.name}`);
  }
}
async function assertTreeSafe(root: string): Promise<void> {
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (FORBIDDEN.test(entry.name)) throw new Error(`插件包含受限路径：${entry.name}`);
    if (entry.isSymbolicLink()) throw new Error(`插件不允许符号链接：${entry.name}`);
    if (entry.isDirectory()) await assertTreeSafe(path.join(root, entry.name));
    else if (entry.isFile() && entry.name !== 'plugin.json' && containsSecret(await readFile(path.join(root, entry.name), 'utf8'))) throw new Error(`插件包含敏感内容：${entry.name}`);
  }
}
function containsSecret(text: string): boolean {
  return /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret)\s*[=:]\s*["']?[^\s"'{}]+/iu.test(text);
}
