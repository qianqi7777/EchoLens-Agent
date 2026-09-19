export type IndexedFileKind = 'source' | 'config' | 'test' | 'docs' | 'unknown-text';

export interface IndexedSymbol {
  name: string;
  kind: string;
  path: string;
  startLine: number;
  endLine: number;
}

export interface IndexedFile {
  path: string;
  kind: IndexedFileKind;
  size: number;
  contentHash: string;
  symbols?: IndexedSymbol[];
  imports?: string[];
  testNames?: string[];
}

export interface WorkspaceIndexSnapshot {
  files: IndexedFile[];
  packageScripts: Record<string, string>;
  warnings: string[];
}

export type FeatureLocationKind = 'entry' | 'implementation' | 'test' | 'docs' | 'config';
export type NavigationToolName = 'read_file' | 'find_symbols' | 'workspace_search' | 'outline_file';

export interface FeatureIndexEntry {
  id: string;
  title: string;
  aliases: string[];
  triggers: string[];
  locations: Array<{
    path: string;
    kind: FeatureLocationKind;
    symbols?: string[];
    priority: number;
  }>;
  searchHints: string[];
  preferredTools: NavigationToolName[];
}

export interface FeatureMatch {
  featureId: string;
  title: string;
  confidence: number;
  paths: string[];
  symbols: string[];
  searchHints: string[];
  preferredTools: NavigationToolName[];
}

export interface NavigationAction {
  tool: NavigationToolName;
  arguments: Record<string, unknown>;
  purpose: string;
}

export interface NavigationHint {
  mode: 'direct' | 'advisory' | 'search';
  confidence: number;
  matches: FeatureMatch[];
  candidatePaths: string[];
  symbols: string[];
  searchHints: string[];
  recommendedActions: NavigationAction[];
}

export interface WorkspaceSearchHit {
  path: string;
  kind: 'file' | 'symbol' | 'text' | 'config' | 'test';
  line?: number;
  symbol?: string;
  excerpt?: string;
  contentHash: string;
  engine: 'feature-index' | 'workspace-index' | 'literal';
}
