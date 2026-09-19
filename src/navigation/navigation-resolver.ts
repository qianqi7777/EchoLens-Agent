import type { FeatureIndexEntry, FeatureMatch, NavigationHint, WorkspaceIndexSnapshot } from './types.js';
import { ECHOLENS_FEATURES } from './feature-index.js';
import { WorkspaceIndex } from './workspace-index.js';

const workspaceIntent = /修复|调试|测试|实现|修改|检查|审查|排查|优化|重构|代码|文件|配置|仓库|路由|会话|工具|审批|沙箱|工作区|评测|mcp|agent|review|bug|debug|test|implement|edit|fix|refactor|file|config|repository|code/iu;
const answerOnlyIntent = /解释|说明|摘要|总结|翻译|是什么|为什么|explain|summari[sz]e|translate|what is|why/iu;
const actionIntent = /修复|调试|修改|重构|新增|删除|fix|debug|implement|edit|refactor|add|delete/iu;
const explicitPath = /(?:^|\s|["'`])([\w@./\\-]+\.(?:ts|tsx|js|jsx|json|md|py|go|rs|java|cs|cpp|h|yaml|yml|toml))(?:$|\s|["'`,，。])/giu;
const resolvers = new Map<string, NavigationResolver>();
const maxCachedResolvers = 8;

export class NavigationResolver {
  readonly workspaceIndex: WorkspaceIndex;

  constructor(workspaceRoot: string, private readonly features: readonly FeatureIndexEntry[] = ECHOLENS_FEATURES) {
    this.workspaceIndex = new WorkspaceIndex(workspaceRoot);
  }

  async resolve(userMessage: string): Promise<NavigationHint | undefined> {
    return this.resolveInternal(userMessage, false);
  }

  async resolveForSearch(query: string): Promise<NavigationHint | undefined> {
    return this.resolveInternal(query, true);
  }

  private async resolveInternal(userMessage: string, forceSearch: boolean): Promise<NavigationHint | undefined> {
    if (!forceSearch && !workspaceIntent.test(userMessage)) return undefined;
    // 首轮导航只需要文件元数据与功能目录中声明的符号；完整 AST 符号索引由
    // workspace_search/find_symbols 按需触发，避免大仓库在首次模型请求前解析全部源码。
    const snapshot = await this.workspaceIndex.build(true, false).catch((): WorkspaceIndexSnapshot => ({ files: [], packageScripts: {}, warnings: ['workspace_index_unavailable'] }));
    const available = new Set(snapshot.files.map((file) => file.path));
    const matches = this.features.map((feature) => matchFeature(feature, userMessage, available, snapshot))
      .filter((match): match is FeatureMatch => Boolean(match)).sort((left, right) => right.confidence - left.confidence).slice(0, 3);
    const directPaths = explicitPaths(userMessage).filter((candidate) => available.has(candidate));
    const confidence = directPaths.length ? 1 : matches[0]?.confidence ?? 0;
    const candidatePaths = unique([...directPaths, ...matches.flatMap((match) => match.paths)]).slice(0, 5);
    const hashes = new Map(snapshot.files.map((file) => [file.path, file.contentHash]));
    const symbols = unique(matches.flatMap((match) => match.symbols)).slice(0, 8);
    const searchHints = unique(matches.flatMap((match) => match.searchHints)).slice(0, 8);
    const preferredTools = unique(matches.flatMap((match) => match.preferredTools));
    const mode = !forceSearch && answerOnlyIntent.test(userMessage) && !actionIntent.test(userMessage)
      ? 'advisory'
      : confidence >= 0.85 ? 'direct' : confidence >= 0.60 ? 'advisory' : 'search';
    const recommendedActions = mode === 'search'
      ? [{ tool: 'workspace_search' as const, arguments: { query: searchQuery(userMessage) }, purpose: '在工作区索引中定位相关文件和符号' }]
      : [
          ...(preferredTools.includes('find_symbols') ? symbols.slice(0, 1) : []).map((symbol) => ({ tool: 'find_symbols' as const, arguments: { query: symbol }, purpose: `定位关键符号 ${symbol}` })),
          ...candidatePaths.slice(0, symbols.length ? 3 : 4).map((path) => ({
            tool: 'read_file' as const,
            arguments: { path, expectedContentHash: hashes.get(path) },
            purpose: '读取匹配功能的候选实现或测试',
          })),
        ].slice(0, 4);
    return { mode, confidence, matches, candidatePaths, symbols, searchHints, recommendedActions };
  }
}

export function navigationResolverFor(workspaceRoot: string): NavigationResolver {
  const key = process.platform === 'win32' ? workspaceRoot.toLowerCase() : workspaceRoot;
  let resolver = resolvers.get(key);
  if (!resolver) {
    resolver = new NavigationResolver(workspaceRoot);
    resolvers.set(key, resolver);
    while (resolvers.size > maxCachedResolvers) {
      const oldest = resolvers.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      resolvers.delete(oldest);
    }
  } else {
    // Map 的插入顺序作为轻量 LRU；活跃工作区移到末尾。
    resolvers.delete(key);
    resolvers.set(key, resolver);
  }
  return resolver;
}

export function parseNavigationMode(value: string | undefined): 'auto' | 'off' {
  const normalized = value?.trim() || 'auto';
  if (normalized === 'auto' || normalized === 'off') return normalized;
  throw new Error('AGENT_NAVIGATION_MODE 必须为 auto 或 off');
}

function matchFeature(feature: FeatureIndexEntry, message: string, available: ReadonlySet<string>, snapshot: WorkspaceIndexSnapshot): FeatureMatch | undefined {
  const normalized = message.toLowerCase();
  const locations = feature.locations.filter((item) => available.has(item.path)).sort((left, right) => right.priority - left.priority);
  // 内置功能目录只对实际存在对应文件的工作区生效，避免其他项目因同名业务词误命中 EchoLens 路径。
  if (locations.length === 0) return undefined;
  let score = 0;
  const phrases = [feature.title, ...feature.aliases].map((value) => value.toLowerCase());
  if (phrases.some((value) => normalized.includes(value))) score += 0.85;
  score += Math.min(0.45, feature.triggers.filter((value) => normalized.includes(value.toLowerCase())).length * 0.15);
  const locationPaths = new Set(locations.map((item) => item.path));
  const indexedSymbols = snapshot.files.filter((file) => locationPaths.has(file.path)).flatMap((file) => file.symbols ?? []);
  const declaredSymbols = locations.flatMap((item) => item.symbols ?? []);
  const symbolHits = unique([...declaredSymbols, ...indexedSymbols.map((symbol) => symbol.name)])
    .filter((symbol) => normalized.includes(symbol.toLowerCase())).length;
  score += Math.min(0.30, symbolHits * 0.15);
  score += Math.min(0.30, feature.locations.filter((item) => normalized.includes(item.path.toLowerCase())).length * 0.30);
  if (score === 0) return undefined;
  return {
    featureId: feature.id, title: feature.title, confidence: Math.min(1, score),
    paths: locations.map((item) => item.path).slice(0, 5),
    symbols: unique(locations.flatMap((item) => item.symbols ?? [])).slice(0, 8),
    searchHints: feature.searchHints.slice(0, 8),
    preferredTools: feature.preferredTools.slice(0, 4),
  };
}

function explicitPaths(message: string): string[] {
  return [...message.matchAll(explicitPath)].map((match) => (match[1] ?? '').replaceAll('\\', '/').replace(/^\.\//u, ''));
}
function searchQuery(message: string): string {
  return message.trim().replace(/[，。！？、,.!?]/gu, ' ').split(/\s+/u).filter(Boolean).slice(0, 8).join(' ').slice(0, 200);
}
function unique(values: string[]): string[] { return [...new Set(values)]; }
