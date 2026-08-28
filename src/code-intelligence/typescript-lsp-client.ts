import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  CancellationTokenSource,
  StreamMessageReader,
  StreamMessageWriter,
  createMessageConnection,
  type MessageConnection,
} from 'vscode-jsonrpc/node';
import { PathPolicy } from '../runtime/path-policy.js';
import type { CodeDiagnostic, CodeLocation } from './types.js';
import { CodeIntelligenceError } from './types.js';

interface OpenDocument {
  uri: string;
  version: number;
  content: string;
}

interface LspPosition { line: number; character: number }
interface LspRange { start: LspPosition; end: LspPosition }
interface PublishDiagnosticsParams { uri: string; diagnostics: unknown[] }

export interface TypeScriptLspClientOptions {
  requestTimeoutMs?: number;
  executable?: string;
  cliPath?: string;
}

export class TypeScriptLspClient {
  private process?: ChildProcessWithoutNullStreams;
  private connection?: MessageConnection;
  private startup?: Promise<void>;
  private readonly documents = new Map<string, OpenDocument>();
  private readonly diagnosticsByUri = new Map<string, CodeDiagnostic[]>();
  private readonly diagnosticWaiters = new Map<string, Array<() => void>>();
  private closed = false;

  constructor(
    private readonly workspaceRoot: string,
    private readonly options: TypeScriptLspClientOptions = {},
  ) {}

  async definition(relativePath: string, line: number, column: number, signal?: AbortSignal): Promise<CodeLocation[]> {
    const document = await this.openDocument(relativePath);
    const result = await this.request('textDocument/definition', {
      textDocument: { uri: document.uri },
      position: position(line, column),
    }, signal);
    return this.normalizeLocations(result);
  }

  async references(relativePath: string, line: number, column: number, signal?: AbortSignal): Promise<CodeLocation[]> {
    const document = await this.openDocument(relativePath);
    const result = await this.request('textDocument/references', {
      textDocument: { uri: document.uri },
      position: position(line, column),
      context: { includeDeclaration: true },
    }, signal);
    return this.normalizeLocations(result);
  }

  async diagnostics(relativePath: string, signal?: AbortSignal): Promise<CodeDiagnostic[]> {
    const document = await this.openDocument(relativePath);
    const existing = this.diagnosticsByUri.get(document.uri);
    if (existing) return structuredClone(existing);
    await waitForDiagnostics(this.diagnosticWaiters, document.uri, signal, 1_500);
    return structuredClone(this.diagnosticsByUri.get(document.uri) ?? []);
  }

  async close(): Promise<void> {
    this.closed = true;
    const connection = this.connection;
    const child = this.process;
    this.connection = undefined;
    this.process = undefined;
    this.startup = undefined;
    if (connection) {
      await Promise.race([
        connection.sendRequest('shutdown').catch(() => undefined),
        new Promise((resolve) => setTimeout(resolve, 1_000)),
      ]);
      await connection.sendNotification('exit').catch(() => undefined);
      connection.dispose();
    }
    if (child && !child.killed) child.kill();
  }

  private async openDocument(relativePath: string): Promise<OpenDocument> {
    await this.ensureStarted();
    const policy = await PathPolicy.create(this.workspaceRoot);
    const file = await policy.readTextFile(relativePath, 2 * 1024 * 1024);
    const normalized = path.relative(policy.workspaceRoot, file.canonicalPath).replaceAll('\\', '/');
    const uri = pathToFileURL(file.canonicalPath).href;
    const current = this.documents.get(normalized);
    if (!current) {
      const opened = { uri, version: 1, content: file.content };
      this.documents.set(normalized, opened);
      await this.connection!.sendNotification('textDocument/didOpen', {
        textDocument: { uri, languageId: languageId(normalized), version: 1, text: file.content },
      });
      return opened;
    }
    if (current.content !== file.content) {
      current.version += 1;
      current.content = file.content;
      this.diagnosticsByUri.delete(uri);
      await this.connection!.sendNotification('textDocument/didChange', {
        textDocument: { uri, version: current.version },
        contentChanges: [{ text: file.content }],
      });
    }
    return current;
  }

  private async ensureStarted(): Promise<void> {
    if (this.closed) throw new CodeIntelligenceError('lsp_unavailable', 'TypeScript LSP 已关闭');
    if (this.connection) return;
    if (!this.startup) this.startup = this.start();
    return this.startup;
  }

  private async start(): Promise<void> {
    const executable = this.options.executable ?? process.execPath;
    const cliPath = this.options.cliPath ?? resolveLanguageServerCli();
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(executable, [cliPath, '--stdio'], {
        cwd: this.workspaceRoot,
        env: safeProcessEnvironment(),
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch {
      throw new CodeIntelligenceError('lsp_unavailable', '无法启动 TypeScript Language Server');
    }
    this.process = child;
    child.stderr.on('data', () => undefined);
    const connection = createMessageConnection(
      new StreamMessageReader(child.stdout),
      new StreamMessageWriter(child.stdin),
    );
    this.connection = connection;
    connection.onRequest('workspace/configuration', (params: unknown) => {
      const items = isRecord(params) && Array.isArray(params.items) ? params.items : [];
      return items.map(() => ({}));
    });
    connection.onRequest('workspace/workspaceFolders', () => [{
      uri: pathToFileURL(this.workspaceRoot).href,
      name: path.basename(this.workspaceRoot),
    }]);
    connection.onRequest('client/registerCapability', () => null);
    connection.onRequest('window/workDoneProgress/create', () => null);
    connection.onNotification('textDocument/publishDiagnostics', (params: PublishDiagnosticsParams) => {
      const diagnostics = params.diagnostics.slice(0, 500).map((value) => normalizeDiagnostic(params.uri, value)).filter(Boolean) as CodeDiagnostic[];
      this.diagnosticsByUri.set(params.uri, diagnostics);
      for (const resolve of this.diagnosticWaiters.get(params.uri) ?? []) resolve();
      this.diagnosticWaiters.delete(params.uri);
    });
    connection.onClose(() => {
      if (!this.closed) {
        this.connection = undefined;
        this.startup = undefined;
      }
    });
    connection.listen();
    try {
      await withTimeout(connection.sendRequest('initialize', {
        processId: process.pid,
        rootUri: pathToFileURL(this.workspaceRoot).href,
        rootPath: this.workspaceRoot,
        workspaceFolders: [{ uri: pathToFileURL(this.workspaceRoot).href, name: path.basename(this.workspaceRoot) }],
        capabilities: {
          workspace: { configuration: true, workspaceFolders: true },
          textDocument: {
            synchronization: { dynamicRegistration: false, didSave: false },
            definition: { linkSupport: true },
            references: {},
            publishDiagnostics: { relatedInformation: true },
          },
        },
        initializationOptions: { preferences: { includeInlayParameterNameHints: 'none' } },
      }), this.options.requestTimeoutMs ?? 10_000);
      await connection.sendNotification('initialized', {});
    } catch {
      await this.close();
      this.closed = false;
      throw new CodeIntelligenceError('lsp_unavailable', 'TypeScript Language Server 初始化失败');
    }
  }

  private async request(method: string, params: unknown, signal?: AbortSignal): Promise<unknown> {
    await this.ensureStarted();
    const cancellation = new CancellationTokenSource();
    const abort = () => cancellation.cancel();
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
    try {
      return await withTimeout(
        this.connection!.sendRequest(method, params, cancellation.token),
        this.options.requestTimeoutMs ?? 10_000,
        () => cancellation.cancel(),
      );
    } catch {
      throw new CodeIntelligenceError('lsp_request_failed', `LSP 请求失败：${method}`);
    } finally {
      signal?.removeEventListener('abort', abort);
      cancellation.dispose();
    }
  }

  private normalizeLocations(value: unknown): CodeLocation[] {
    const values = Array.isArray(value) ? value : value ? [value] : [];
    const locations: CodeLocation[] = [];
    for (const item of values.slice(0, 1_000)) {
      if (!isRecord(item)) continue;
      const uri = typeof item.uri === 'string' ? item.uri : typeof item.targetUri === 'string' ? item.targetUri : undefined;
      const range = isRange(item.range) ? item.range : isRange(item.targetSelectionRange) ? item.targetSelectionRange : undefined;
      if (!uri || !range) continue;
      const normalized = this.locationFromUri(uri, range);
      if (normalized) locations.push(normalized);
    }
    return locations;
  }

  private locationFromUri(uri: string, range: LspRange): CodeLocation | undefined {
    try {
      const absolute = fileURLToPath(uri);
      const relative = path.relative(path.resolve(this.workspaceRoot), path.resolve(absolute));
      if (relative.startsWith('..') || path.isAbsolute(relative)) return undefined;
      return {
        path: relative.replaceAll('\\', '/'),
        startLine: range.start.line + 1,
        startColumn: range.start.character + 1,
        endLine: range.end.line + 1,
        endColumn: range.end.character + 1,
      };
    } catch { return undefined; }
  }
}

function resolveLanguageServerCli(): string {
  try { return createRequire(import.meta.url).resolve('typescript-language-server/lib/cli.mjs'); }
  catch { throw new CodeIntelligenceError('lsp_unavailable', '未安装 typescript-language-server'); }
}

function safeProcessEnvironment(): NodeJS.ProcessEnv {
  const names = ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA'];
  const env: NodeJS.ProcessEnv = { NO_COLOR: '1' };
  for (const name of names) if (process.env[name] !== undefined) env[name] = process.env[name];
  return env;
}

function normalizeDiagnostic(uri: string, value: unknown): CodeDiagnostic | undefined {
  if (!isRecord(value) || !isRange(value.range) || typeof value.message !== 'string') return undefined;
  let relative: string;
  try { relative = fileURLToPath(uri); } catch { return undefined; }
  const severity = value.severity === 1 ? 'error' : value.severity === 2 ? 'warning' : value.severity === 4 ? 'hint' : 'information';
  const target = {
    path: relative,
    startLine: value.range.start.line + 1,
    startColumn: value.range.start.character + 1,
    endLine: value.range.end.line + 1,
    endColumn: value.range.end.character + 1,
  };
  const evidence = createEvidenceId(`${uri}:${target.startLine}:${target.startColumn}:${value.message}`);
  return {
    ...target,
    severity,
    message: value.message.slice(0, 2_000),
    source: 'lsp',
    code: typeof value.code === 'string' || typeof value.code === 'number' ? String(value.code) : undefined,
    evidenceId: `code:${evidence}`,
  };
}

function position(line: number, column: number): LspPosition {
  if (!Number.isInteger(line) || line < 1 || !Number.isInteger(column) || column < 1) {
    throw new CodeIntelligenceError('code_intelligence_failed', '行列必须从 1 开始');
  }
  return { line: line - 1, character: column - 1 };
}

function isRange(value: unknown): value is LspRange {
  return isRecord(value) && isPosition(value.start) && isPosition(value.end);
}
function isPosition(value: unknown): value is LspPosition {
  return isRecord(value) && Number.isInteger(value.line) && Number.isInteger(value.character);
}
function isRecord(value: unknown): value is Record<string, any> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function languageId(relative: string): string { return /\.tsx$/iu.test(relative) ? 'typescriptreact' : 'typescript'; }
function createEvidenceId(value: string): string { return Buffer.from(value).toString('base64url').slice(0, 32); }

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, onTimeout?: () => void): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => { onTimeout?.(); reject(new Error('LSP_TIMEOUT')); }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function waitForDiagnostics(
  waiters: Map<string, Array<() => void>>,
  uri: string,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<void> {
  if (signal?.aborted) return;
  await new Promise<void>((resolve) => {
    const complete = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', complete);
      resolve();
    };
    const timer = setTimeout(complete, timeoutMs);
    const current = waiters.get(uri) ?? [];
    current.push(complete);
    waiters.set(uri, current);
    signal?.addEventListener('abort', complete, { once: true });
  });
}
