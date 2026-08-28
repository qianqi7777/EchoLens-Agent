export interface CodeLocation {
  path: string;
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
}

export interface CodeSymbol extends CodeLocation {
  id: string;
  evidenceId: string;
  name: string;
  kind: string;
}

export interface CodeDiagnostic extends CodeLocation {
  severity: 'error' | 'warning' | 'information' | 'hint';
  message: string;
  source: 'lsp' | 'tree-sitter-fallback';
  code?: string;
  evidenceId: string;
}

export class CodeIntelligenceError extends Error {
  constructor(
    readonly code: 'code_intelligence_failed' | 'lsp_unavailable' | 'lsp_request_failed',
    message: string,
  ) {
    super(message);
    this.name = 'CodeIntelligenceError';
  }
}
