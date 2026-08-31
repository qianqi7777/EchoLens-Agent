/**
 * 工作区内的位置：path 为相对工作区根、以 / 分隔的路径；行与列均为 1 基
 * （LSP 原始结果为 0 基，转换由各引擎完成）。
 */
export interface CodeLocation {
  path: string;
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
}

/**
 * 符号定义：id 用于符号去重，evidenceId 用于关联事件追踪。
 */
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
