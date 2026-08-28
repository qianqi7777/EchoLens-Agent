import { createHash } from 'node:crypto';
import * as path from 'node:path';
import Parser from 'tree-sitter';
import TypeScript from 'tree-sitter-typescript';
import { PathPolicy } from '../runtime/path-policy.js';
import type { CodeDiagnostic, CodeLocation, CodeSymbol } from './types.js';
import { CodeIntelligenceError } from './types.js';

interface ParsedFile {
  hash: string;
  source: string;
  tree: Parser.Tree;
  symbols: CodeSymbol[];
}

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs']);
const IGNORED_DIRECTORIES = new Set(['.git', '.echolens', 'node_modules', 'coverage', 'dist', 'build', 'studydocs']);
const SYMBOL_QUERY = String.raw`
  (function_declaration name: (identifier) @name) @definition.function
  (class_declaration name: (type_identifier) @name) @definition.class
  (interface_declaration name: (type_identifier) @name) @definition.interface
  (type_alias_declaration name: (type_identifier) @name) @definition.type
  (enum_declaration name: (identifier) @name) @definition.enum
  (method_definition name: [(property_identifier) (private_property_identifier)] @name) @definition.method
  (public_field_definition name: [(property_identifier) (private_property_identifier)] @name) @definition.field
  (lexical_declaration (variable_declarator name: (identifier) @name value: [(arrow_function) (function_expression)]) @definition.function)
`;

export class TreeSitterIndex {
  private readonly cache = new Map<string, ParsedFile>();
  private readonly queries = new Map<'typescript' | 'tsx', Parser.Query>();

  async outline(workspaceRoot: string, relativePath: string): Promise<CodeSymbol[]> {
    return structuredClone((await this.parse(workspaceRoot, relativePath)).symbols);
  }

  async searchSymbols(workspaceRoot: string, query: string, relative = '.'): Promise<CodeSymbol[]> {
    const policy = await PathPolicy.create(workspaceRoot);
    const files = await sourceFiles(policy, relative, 5_000);
    const normalized = query.trim().toLowerCase();
    const results: CodeSymbol[] = [];
    for (const file of files) {
      const parsed = await this.parse(policy.workspaceRoot, file);
      for (const symbol of parsed.symbols) {
        if (!normalized || symbol.name.toLowerCase().includes(normalized)) results.push(symbol);
        if (results.length >= 500) return results;
      }
    }
    return results;
  }

  async symbolAt(workspaceRoot: string, relativePath: string, line: number, column: number): Promise<CodeSymbol | undefined> {
    const parsed = await this.parse(workspaceRoot, relativePath);
    const row = line - 1;
    const col = column - 1;
    return parsed.symbols
      .filter((symbol) => contains(symbol, row, col))
      .sort((left, right) => span(left) - span(right))[0];
  }

  async referencesByName(workspaceRoot: string, name: string, relative = '.'): Promise<CodeLocation[]> {
    const policy = await PathPolicy.create(workspaceRoot);
    const files = await sourceFiles(policy, relative, 5_000);
    const locations: CodeLocation[] = [];
    for (const file of files) {
      const parsed = await this.parse(policy.workspaceRoot, file);
      const nodes = parsed.tree.rootNode.descendantsOfType(['identifier', 'type_identifier', 'property_identifier']);
      for (const node of nodes) {
        if (node.text !== name) continue;
        locations.push(location(file, node));
        if (locations.length >= 1_000) return locations;
      }
    }
    return locations;
  }

  async diagnostics(workspaceRoot: string, relativePath: string): Promise<CodeDiagnostic[]> {
    const parsed = await this.parse(workspaceRoot, relativePath);
    return parsed.tree.rootNode.descendantsOfType('ERROR').slice(0, 100).map((node) => {
      const target = location(relativePath, node);
      return {
        ...target,
        severity: 'error',
        message: 'tree-sitter 检测到语法错误',
        source: 'tree-sitter-fallback',
        evidenceId: evidenceId(relativePath, target.startLine, target.startColumn, 'syntax-error'),
      };
    });
  }

  private async parse(workspaceRoot: string, relativePath: string): Promise<ParsedFile> {
    const extension = path.extname(relativePath).toLowerCase();
    if (!SOURCE_EXTENSIONS.has(extension)) {
      throw new CodeIntelligenceError('code_intelligence_failed', `tree-sitter 暂不支持该文件类型：${extension}`);
    }
    const policy = await PathPolicy.create(workspaceRoot);
    const file = await policy.readTextFile(relativePath, 2 * 1024 * 1024);
    const normalizedPath = path.relative(policy.workspaceRoot, file.canonicalPath).replaceAll('\\', '/');
    const hash = createHash('sha256').update(file.content).digest('hex');
    const key = `${policy.workspaceRoot}\0${normalizedPath}`;
    const cached = this.cache.get(key);
    if (cached?.hash === hash) return cached;
    const dialect = extension === '.tsx' || extension === '.jsx' ? 'tsx' : 'typescript';
    const language = TypeScript[dialect];
    const parser = new Parser();
    parser.setLanguage(language);
    const tree = parser.parse(file.content);
    let query = this.queries.get(dialect);
    if (!query) {
      query = new Parser.Query(language, SYMBOL_QUERY);
      this.queries.set(dialect, query);
    }
    const symbols = symbolsFromMatches(normalizedPath, query.matches(tree.rootNode));
    const parsed = { hash, source: file.content, tree, symbols };
    this.cache.set(key, parsed);
    return parsed;
  }
}

function symbolsFromMatches(relativePath: string, matches: Parser.QueryMatch[]): CodeSymbol[] {
  const symbols: CodeSymbol[] = [];
  for (const match of matches.slice(0, 1_000)) {
    const name = match.captures.find((capture) => capture.name === 'name');
    const definition = match.captures.find((capture) => capture.name.startsWith('definition.'));
    if (!name || !definition) continue;
    const kind = definition.name.slice('definition.'.length);
    const target = location(relativePath, definition.node);
    const id = evidenceId(relativePath, target.startLine, target.startColumn, `${kind}:${name.node.text}`);
    symbols.push({ ...target, id: `symbol:${id}`, evidenceId: `code:${id}`, name: name.node.text, kind });
  }
  return symbols;
}

async function sourceFiles(policy: PathPolicy, relative: string, limit: number): Promise<string[]> {
  const resolved = await policy.resolveExisting(relative);
  if (resolved.stat.isFile()) return SOURCE_EXTENSIONS.has(path.extname(relative).toLowerCase()) ? [relative] : [];
  const files: string[] = [];
  await walk(policy, relative, files, limit);
  return files;
}

async function walk(policy: PathPolicy, relative: string, files: string[], limit: number): Promise<void> {
  if (files.length >= limit) return;
  const directory = await policy.readDirectory(relative);
  for (const entry of directory.entries) {
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory() && IGNORED_DIRECTORIES.has(entry.name.toLowerCase())) continue;
    const child = relative === '.' ? entry.name : path.join(relative, entry.name);
    if (entry.isDirectory()) await walk(policy, child, files, limit);
    else if (entry.isFile() && SOURCE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) files.push(child);
    if (files.length >= limit) return;
  }
}

function location(relativePath: string, node: Parser.SyntaxNode): CodeLocation {
  return {
    path: relativePath.replaceAll('\\', '/'),
    startLine: node.startPosition.row + 1,
    startColumn: node.startPosition.column + 1,
    endLine: node.endPosition.row + 1,
    endColumn: node.endPosition.column + 1,
  };
}

function contains(symbol: CodeSymbol, row: number, column: number): boolean {
  const startsBefore = row > symbol.startLine - 1 || (row === symbol.startLine - 1 && column >= symbol.startColumn - 1);
  const endsAfter = row < symbol.endLine - 1 || (row === symbol.endLine - 1 && column <= symbol.endColumn - 1);
  return startsBefore && endsAfter;
}

function span(symbol: CodeSymbol): number {
  return (symbol.endLine - symbol.startLine) * 1_000_000 + symbol.endColumn - symbol.startColumn;
}

function evidenceId(relativePath: string, line: number, column: number, value: string): string {
  return createHash('sha256').update(`${relativePath}\0${line}\0${column}\0${value}`).digest('hex').slice(0, 24);
}
