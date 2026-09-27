import * as path from 'node:path';
import type { IndexedFile, WorkspaceIndexSnapshot } from './types.js';
import { WorkspaceIndex } from './workspace-index.js';

export interface DependencyGraphOptions {
  maxHops?: number;
  maxNodes?: number;
}

export interface DependencyGraphEdge {
  from: string;
  to: string;
  relation: 'dependency' | 'dependent';
  importPath: string;
}

export interface DependencyGraphResult {
  roots: string[];
  paths: string[];
  edges: DependencyGraphEdge[];
  truncated: boolean;
  warnings: string[];
}

const DEFAULT_MAX_HOPS = 2;
const DEFAULT_MAX_NODES = 128;

/**
 * 从 WorkspaceIndex 的只读 import 证据构建有界依赖图。
 * 当前实现不把文本近似伪装成语义 LSP 结果；未来若接入 call hierarchy，
 * 可在此层优先合并语义边，再用本图作为确定性兜底。
 */
export class DependencyGraph {
  constructor(
    workspaceRoot: string,
    private readonly workspaceIndex = new WorkspaceIndex(workspaceRoot),
  ) {}

  async relatedFiles(roots: readonly string[], options: DependencyGraphOptions = {}): Promise<DependencyGraphResult> {
    const snapshot = await this.workspaceIndex.build(false, false);
    return this.fromSnapshot(snapshot, roots, options);
  }

  fromSnapshot(
    snapshot: WorkspaceIndexSnapshot,
    roots: readonly string[],
    options: DependencyGraphOptions = {},
  ): DependencyGraphResult {
    const maxHops = integerLimit(options.maxHops ?? DEFAULT_MAX_HOPS, 0, 8, 'maxHops');
    const maxNodes = integerLimit(options.maxNodes ?? DEFAULT_MAX_NODES, 1, 2_000, 'maxNodes');
    const files = new Map(snapshot.files.map((file) => [normalize(file.path), file]));
    const normalizedRoots = [...new Set(roots.map(normalize).filter((root) => files.has(root)))];
    const outgoing = new Map<string, Array<{ path: string; importPath: string }>>();
    const incoming = new Map<string, Array<{ path: string; importPath: string }>>();
    for (const file of files.values()) {
      for (const importPath of file.imports ?? []) {
        const target = resolveImport(file.path, importPath, files);
        if (!target) continue;
        const next = outgoing.get(file.path) ?? [];
        next.push({ path: target, importPath });
        outgoing.set(file.path, next);
        const previous = incoming.get(target) ?? [];
        previous.push({ path: file.path, importPath });
        incoming.set(target, previous);
      }
    }
    const visited = new Set(normalizedRoots);
    const distance = new Map(normalizedRoots.map((root) => [root, 0]));
    const queue = [...normalizedRoots];
    const edges: DependencyGraphEdge[] = [];
    let truncated = false;
    while (queue.length) {
      const current = queue.shift()!;
      const currentDistance = distance.get(current) ?? 0;
      if (currentDistance >= maxHops) continue;
      const neighbours = [
        ...(outgoing.get(current) ?? []).map((item) => ({ ...item, relation: 'dependency' as const, from: current, to: item.path })),
        ...(incoming.get(current) ?? []).map((item) => ({ ...item, relation: 'dependent' as const, from: item.path, to: current })),
      ].sort((left, right) => `${left.from}\0${left.to}`.localeCompare(`${right.from}\0${right.to}`));
      for (const neighbour of neighbours) {
        edges.push({ from: neighbour.from, to: neighbour.to, relation: neighbour.relation, importPath: neighbour.importPath });
        const nextPath = neighbour.relation === 'dependency' ? neighbour.to : neighbour.from;
        if (visited.has(nextPath)) continue;
        if (visited.size >= maxNodes) {
          truncated = true;
          continue;
        }
        visited.add(nextPath);
        distance.set(nextPath, currentDistance + 1);
        queue.push(nextPath);
      }
    }
    const paths = [...visited].filter((item) => !normalizedRoots.includes(item));
    return {
      roots: normalizedRoots,
      paths,
      edges: dedupeEdges(edges),
      truncated,
      warnings: snapshot.warnings.slice(0, 10),
    };
  }
}

function resolveImport(from: string, importPath: string, files: ReadonlyMap<string, IndexedFile>): string | undefined {
  if (!importPath.startsWith('.')) return undefined;
  const base = normalize(path.posix.join(path.posix.dirname(from), importPath));
  const sourceExtensions = ['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs', '.json'];
  const stem = sourceExtensions.includes(path.posix.extname(base).toLowerCase())
    ? base.slice(0, -path.posix.extname(base).length) : base;
  const candidates = [base, ...sourceExtensions.flatMap((ext) => [`${base}${ext}`, `${stem}${ext}`]),
    ...sourceExtensions.filter((ext) => ext !== '.json').map((ext) => `${base}/index${ext}`)];
  return candidates.find((candidate) => files.has(candidate));
}

function dedupeEdges(edges: DependencyGraphEdge[]): DependencyGraphEdge[] {
  const seen = new Set<string>();
  return edges.filter((edge) => {
    const key = `${edge.from}\0${edge.to}\0${edge.relation}\0${edge.importPath}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function normalize(value: string): string {
  return value.replaceAll('\\', '/').replace(/^\.\//u, '').replace(/\/+$/u, '') || '.';
}

function integerLimit(value: number, min: number, max: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${name} 超出范围`);
  return value;
}
