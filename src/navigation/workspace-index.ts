import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { TreeSitterIndex } from '../code-intelligence/tree-sitter-index.js';
import { PathPolicy, PathPolicyError } from '../runtime/path-policy.js';
import type { IndexedFile, IndexedFileKind, WorkspaceIndexSnapshot, WorkspaceSearchHit } from './types.js';

const ignoredDirectories = new Set([
  '.git', '.echolens', 'node_modules', '.venv', 'vendor', 'coverage', 'dist', 'build', 'out', 'target',
  '.next', '.turbo', 'studydoc', 'studydocs', '.workbuddy',
]);
const sourceExtensions = new Set(['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs', '.py', '.go', '.rs', '.java', '.kt', '.cs', '.cpp', '.h']);
const configExtensions = new Set(['.json', '.jsonc', '.yaml', '.yml', '.toml', '.ini', '.config']);
const docsExtensions = new Set(['.md', '.mdx', '.txt', '.rst']);
const otherTextExtensions = new Set(['.css', '.scss', '.html', '.xml', '.sql', '.sh', '.ps1']);
const treeSitterExtensions = new Set(['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs']);
const maxIndexedFiles = 5_000;
const maxIndexedFileBytes = 512 * 1024;

interface CacheEntry {
  contentHash: string;
  file: IndexedFile;
  content: string;
  symbolsIndexed: boolean;
}

export class WorkspaceIndex {
  private readonly cache = new Map<string, CacheEntry>();
  private snapshot?: WorkspaceIndexSnapshot;
  private readonly treeSitter = new TreeSitterIndex();

  constructor(private readonly workspaceRoot: string) {}

  async build(force = false, includeSymbols = false): Promise<WorkspaceIndexSnapshot> {
    if (this.snapshot && !force && (!includeSymbols || this.hasIndexedSymbols())) return structuredClone(this.snapshot);
    const policy = await PathPolicy.create(this.workspaceRoot);
    const paths: string[] = [];
    const warnings: string[] = [];
    await collectTextFiles(policy, '.', paths, warnings);
    const files: IndexedFile[] = [];
    const packageScripts: Record<string, string> = {};
    for (const relativePath of paths.slice(0, maxIndexedFiles)) {
      const loaded = await this.indexFile(policy, relativePath, includeSymbols).catch((error) => {
        warnings.push(`未索引 ${relativePath}：${safeMessage(error)}`);
        return undefined;
      });
      if (!loaded) continue;
      files.push(loaded.file);
      if (relativePath === 'package.json') Object.assign(packageScripts, parsePackageScripts(loaded.content));
    }
    if (paths.length > maxIndexedFiles) warnings.push(`工作区文本文件超过索引上限 ${maxIndexedFiles}`);
    files.sort((left, right) => left.path.localeCompare(right.path));
    this.snapshot = { files, packageScripts, warnings: warnings.slice(0, 50) };
    return structuredClone(this.snapshot);
  }

  async search(
    query: string,
    options: { path?: string; kinds?: string[]; limit?: number } = {},
  ): Promise<WorkspaceSearchHit[]> {
    const needsSymbols = !options.kinds || options.kinds.includes('symbol');
    const snapshot = await this.build(false, needsSymbols);
    const terms = queryTerms(query);
    const prefix = normalizePath(options.path ?? '.');
    const allowedKinds = new Set(options.kinds ?? ['file', 'symbol', 'text', 'config', 'test']);
    const limit = Math.min(100, Math.max(1, options.limit ?? 50));
    const results: WorkspaceSearchHit[] = [];
    const files = snapshot.files.filter((file) => withinPrefix(file.path, prefix));

    // 先返回结构化的文件类别命中，再返回符号，最后才扫描普通文本。这样在较小 limit 下，
    // 早期文件中的注释或文档文本不会挤掉后续文件里更可操作的符号结果。
    for (const file of files) {
      if (allowedKinds.has('file') && includesAny(file.path, terms)) {
        results.push(hit(file, 'file', 'workspace-index'));
      }
      if (allowedKinds.has('config') && file.kind === 'config' && searchableFile(file, terms)) {
        results.push(hit(file, 'config', 'workspace-index'));
      }
      if (allowedKinds.has('test') && file.kind === 'test' && searchableFile(file, terms)) {
        results.push(hit(file, 'test', 'workspace-index'));
      }
      if (results.length >= limit) return results.slice(0, limit);
    }
    if (allowedKinds.has('symbol')) {
      for (const file of files) {
        for (const symbol of file.symbols ?? []) {
          if (!includesAny(symbol.name, terms)) continue;
          results.push({
            path: file.path, kind: 'symbol', line: symbol.startLine, symbol: symbol.name,
            excerpt: `${symbol.kind} ${symbol.name}`, contentHash: file.contentHash, engine: 'workspace-index',
          });
          if (results.length >= limit) return results;
        }
      }
    }
    if (allowedKinds.has('text')) {
      for (const file of files) {
        const content = this.cache.get(file.path)?.content;
        if (content) {
          for (const [index, line] of content.split(/\r?\n/u).entries()) {
            if (!includesAny(line, terms)) continue;
            results.push({
              path: file.path, kind: 'text', line: index + 1, excerpt: line.trim().slice(0, 240),
              contentHash: file.contentHash, engine: 'literal',
            });
            if (results.length >= limit) return results;
          }
        }
      }
    }
    return results.slice(0, limit);
  }

  invalidate(): void {
    this.snapshot = undefined;
  }

  private async indexFile(policy: PathPolicy, relativePath: string, includeSymbols: boolean): Promise<CacheEntry> {
    const { content } = await policy.readTextFile(relativePath, maxIndexedFileBytes);
    const contentHash = createHash('sha256').update(content).digest('hex');
    const cached = this.cache.get(relativePath);
    const extension = path.extname(relativePath).toLowerCase();
    if (cached?.contentHash === contentHash && (!includeSymbols || cached.symbolsIndexed || !treeSitterExtensions.has(extension))) return cached;
    const kind = fileKind(relativePath, extension);
    const symbols = includeSymbols && treeSitterExtensions.has(extension)
      ? this.treeSitter.outlineSource(policy.workspaceRoot, relativePath, content).map((item) => ({
          name: item.name,
          kind: item.kind,
          path: item.path,
          startLine: item.startLine,
          endLine: item.endLine,
        }))
      : [];
    const file: IndexedFile = {
      path: normalizePath(relativePath),
      kind,
      size: Buffer.byteLength(content, 'utf8'),
      contentHash,
      symbols: symbols.length ? symbols : undefined,
      imports: sourceExtensions.has(extension) ? extractImports(content) : undefined,
      testNames: kind === 'test' ? extractTestNames(content) : undefined,
    };
    const entry = { contentHash, file, content, symbolsIndexed: includeSymbols && treeSitterExtensions.has(extension) };
    this.cache.set(file.path, entry);
    return entry;
  }

  private hasIndexedSymbols(): boolean {
    return [...this.cache.values()].every((entry) => entry.symbolsIndexed
      || !treeSitterExtensions.has(path.extname(entry.file.path).toLowerCase()));
  }
}

async function collectTextFiles(policy: PathPolicy, relative: string, files: string[], warnings: string[]): Promise<void> {
  if (files.length >= maxIndexedFiles + 1) return;
  const directory = await policy.readDirectory(relative);
  for (const entry of directory.entries) {
    if (entry.isSymbolicLink()) {
      warnings.push(`已跳过符号链接：${relative === '.' ? entry.name : `${relative}/${entry.name}`}`);
      continue;
    }
    if (entry.isDirectory() && ignoredDirectories.has(entry.name.toLowerCase())) continue;
    const child = normalizePath(relative === '.' ? entry.name : `${relative}/${entry.name}`);
    if (entry.isDirectory()) await collectTextFiles(policy, child, files, warnings);
    else if (entry.isFile() && isIndexableText(child)) files.push(child);
    if (files.length >= maxIndexedFiles + 1) return;
  }
}

function isIndexableText(relativePath: string): boolean {
  const name = path.posix.basename(relativePath).toLowerCase();
  if (name === 'agents.md' || name === 'agents.override.md' || name.startsWith('.env')) return false;
  if (/(credential|secret|token|private[-_.]?key)/u.test(name)) return false;
  if (['package.json', 'tsconfig.json', 'readme', 'license'].includes(name)) return true;
  const extension = path.extname(name);
  return sourceExtensions.has(extension) || configExtensions.has(extension)
    || docsExtensions.has(extension) || otherTextExtensions.has(extension);
}

function fileKind(relativePath: string, extension: string): IndexedFileKind {
  const normalized = relativePath.toLowerCase();
  if (/(^|\/)(test|tests|__tests__|spec)(\/|$)/u.test(normalized) || /\.(test|spec)\.[^.]+$/u.test(normalized)) return 'test';
  if (configExtensions.has(extension) || /(^|\/)(package|tsconfig)[^/]*\.json$/u.test(normalized)) return 'config';
  if (docsExtensions.has(extension) || /(^|\/)readme(?:\.|$)/u.test(normalized)) return 'docs';
  if (sourceExtensions.has(extension)) return 'source';
  return 'unknown-text';
}

function extractImports(content: string): string[] {
  const imports = new Set<string>();
  for (const match of content.matchAll(/(?:from\s+|import\s*\(|require\s*\()\s*['"]([^'"]+)['"]/gu)) {
    if (match[1]) imports.add(match[1]);
    if (imports.size >= 100) break;
  }
  return [...imports];
}

function extractTestNames(content: string): string[] {
  const names: string[] = [];
  for (const match of content.matchAll(/\b(?:test|it|describe)\s*\(\s*['"`]([^'"`]{1,200})['"`]/gu)) {
    if (match[1]) names.push(match[1]);
    if (names.length >= 100) break;
  }
  return names;
}

function parsePackageScripts(content: string): Record<string, string> {
  try {
    const parsed = JSON.parse(content) as { scripts?: unknown };
    if (!parsed.scripts || typeof parsed.scripts !== 'object' || Array.isArray(parsed.scripts)) return {};
    return Object.fromEntries(Object.entries(parsed.scripts).filter((item): item is [string, string] => typeof item[1] === 'string'));
  } catch {
    return {};
  }
}

function searchableFile(file: IndexedFile, terms: string[]): boolean {
  return includesAny(file.path, terms) || (file.testNames ?? []).some((name) => includesAny(name, terms));
}

function includesAny(value: string, terms: string[]): boolean {
  const normalized = value.toLowerCase();
  return terms.some((term) => normalized.includes(term));
}

function queryTerms(query: string): string[] {
  const normalized = query.trim().toLowerCase();
  const terms = normalized.split(/[^\p{L}\p{N}_.-]+/u).filter((term) => term.length >= 2);
  for (const sequence of normalized.match(/[\p{Script=Han}]{3,}/gu) ?? []) {
    for (let index = 0; index < sequence.length - 1; index += 1) terms.push(sequence.slice(index, index + 2));
  }
  return [...new Set(terms)].slice(0, 32);
}

function hit(file: IndexedFile, kind: WorkspaceSearchHit['kind'], engine: WorkspaceSearchHit['engine']): WorkspaceSearchHit {
  return { path: file.path, kind, contentHash: file.contentHash, engine };
}

function withinPrefix(file: string, prefix: string): boolean {
  return prefix === '.' || file === prefix || file.startsWith(`${prefix}/`);
}

function normalizePath(value: string): string {
  return value.replaceAll('\\', '/').replace(/^\.\//u, '').replace(/\/$/u, '') || '.';
}

function safeMessage(error: unknown): string {
  if (error instanceof PathPolicyError) return error.code;
  return error instanceof Error ? error.message.slice(0, 120) : 'unknown';
}
