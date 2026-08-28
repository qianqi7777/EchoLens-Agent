import type { CodeDiagnostic, CodeLocation, CodeSymbol } from './types.js';
import { CodeIntelligenceError } from './types.js';
import { TreeSitterIndex } from './tree-sitter-index.js';
import { TypeScriptLspClient } from './typescript-lsp-client.js';

export type CodeIntelligenceEngine = 'lsp' | 'tree-sitter';

export interface CodeIntelligenceResult<T> {
  engine: CodeIntelligenceEngine;
  items: T[];
  fallbackReason?: 'lsp_unavailable' | 'lsp_request_failed' | 'empty_lsp_result';
}

export interface LanguageServiceBackend {
  definition(path: string, line: number, column: number, signal?: AbortSignal): Promise<CodeLocation[]>;
  references(path: string, line: number, column: number, signal?: AbortSignal): Promise<CodeLocation[]>;
  diagnostics(path: string, signal?: AbortSignal): Promise<CodeDiagnostic[]>;
  close(): Promise<void>;
}

export interface CodeIntelligenceServiceOptions {
  treeSitter?: TreeSitterIndex;
  languageService?: LanguageServiceBackend;
}

/**
 * LSP supplies semantic answers when available; tree-sitter remains the local,
 * deterministic fallback so read-only code navigation never depends on a daemon.
 */
export class CodeIntelligenceService {
  private readonly treeSitter: TreeSitterIndex;
  private readonly languageService: LanguageServiceBackend;

  constructor(
    private readonly workspaceRoot: string,
    options: CodeIntelligenceServiceOptions = {},
  ) {
    this.treeSitter = options.treeSitter ?? new TreeSitterIndex();
    this.languageService = options.languageService ?? new TypeScriptLspClient(workspaceRoot);
  }

  async outlineFile(path: string): Promise<CodeIntelligenceResult<CodeSymbol>> {
    return { engine: 'tree-sitter', items: await this.treeSitter.outline(this.workspaceRoot, path) };
  }

  async findSymbols(query: string, path = '.'): Promise<CodeIntelligenceResult<CodeSymbol>> {
    return { engine: 'tree-sitter', items: await this.treeSitter.searchSymbols(this.workspaceRoot, query, path) };
  }

  async goToDefinition(
    path: string,
    line: number,
    column: number,
    signal?: AbortSignal,
  ): Promise<CodeIntelligenceResult<CodeLocation>> {
    try {
      const locations = await this.languageService.definition(path, line, column, signal);
      const fallback = await this.definitionFallback(path, line, column);
      if (locations.length) return { engine: 'lsp', items: mergeLocations(locations, fallback) };
      return {
        engine: 'tree-sitter',
        items: fallback,
        fallbackReason: 'empty_lsp_result',
      };
    } catch (error) {
      const fallbackReason = recoverableLspReason(error);
      return {
        engine: 'tree-sitter',
        items: await this.definitionFallback(path, line, column),
        fallbackReason,
      };
    }
  }

  async findReferences(
    path: string,
    line: number,
    column: number,
    signal?: AbortSignal,
  ): Promise<CodeIntelligenceResult<CodeLocation>> {
    try {
      const locations = await this.languageService.references(path, line, column, signal);
      const fallback = await this.referencesFallback(path, line, column);
      if (locations.length) return { engine: 'lsp', items: mergeLocations(locations, fallback) };
      return {
        engine: 'tree-sitter',
        items: fallback,
        fallbackReason: 'empty_lsp_result',
      };
    } catch (error) {
      const fallbackReason = recoverableLspReason(error);
      return {
        engine: 'tree-sitter',
        items: await this.referencesFallback(path, line, column),
        fallbackReason,
      };
    }
  }

  async getDiagnostics(path: string, signal?: AbortSignal): Promise<CodeIntelligenceResult<CodeDiagnostic>> {
    try {
      return { engine: 'lsp', items: await this.languageService.diagnostics(path, signal) };
    } catch (error) {
      return {
        engine: 'tree-sitter',
        items: await this.treeSitter.diagnostics(this.workspaceRoot, path),
        fallbackReason: recoverableLspReason(error),
      };
    }
  }

  async close(): Promise<void> {
    await this.languageService.close();
  }

  private async definitionFallback(path: string, line: number, column: number): Promise<CodeLocation[]> {
    const name = await this.treeSitter.nameAt(this.workspaceRoot, path, line, column);
    if (!name) return [];
    const candidates = await this.treeSitter.searchSymbols(this.workspaceRoot, name);
    return candidates.filter((candidate) => candidate.name === name);
  }

  private async referencesFallback(path: string, line: number, column: number): Promise<CodeLocation[]> {
    const name = await this.treeSitter.nameAt(this.workspaceRoot, path, line, column);
    return name
      ? this.treeSitter.referencesByName(this.workspaceRoot, name)
      : [];
  }
}

function recoverableLspReason(error: unknown): 'lsp_unavailable' | 'lsp_request_failed' {
  if (error instanceof CodeIntelligenceError
    && (error.code === 'lsp_unavailable' || error.code === 'lsp_request_failed')) {
    return error.code;
  }
  return 'lsp_request_failed';
}

function mergeLocations(primary: CodeLocation[], fallback: CodeLocation[]): CodeLocation[] {
  const seen = new Set<string>();
  return [...primary, ...fallback].filter((item) => {
    const key = `${item.path}:${item.startLine}:${item.startColumn}:${item.endLine}:${item.endColumn}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
