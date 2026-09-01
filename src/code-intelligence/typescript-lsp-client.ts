import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
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
  private workspaceCanonicalRoot?: string;
  private closed = false;

  constructor(
    private readonly workspaceRoot: string,
    private readonly options: TypeScriptLspClientOptions = {},
  ) {}

  async definition(relativePath: string, line: number, column: number, signal?: AbortSignal): Promise<CodeLocation[]> {
    const document = await this.openDocument(relativePath);
    // 只执行 tsserver 内置的“跳转到源位置”命令，绝不转发任意 workspace 命令，
    // 避免把项目自定义命令当作可执行入口。
    const sourceDefinition = this.normalizeLocations(await this.request('workspace/executeCommand', {
      command: '_typescript.goToSourceDefinition',
      arguments: [document.uri, position(line, column)],
    }, signal).catch(() => []));
    const first = this.normalizeLocations(await this.request('textDocument/definition', {
      textDocument: { uri: document.uri },
      position: position(line, column),
    }, signal));
    if (sourceDefinition.length) return dedupeLocations([...sourceDefinition, ...first]);
    if (first.length !== 1 || first[0]!.path !== relativePath.replaceAll('\\', '/')) return first;
    const alias = first[0]!;
    if (alias.startLine === line && alias.startColumn === column) return first;
    const aliasDocument = await this.openDocument(alias.path);
    const target = this.normalizeLocations(await this.request('textDocument/definition', {
      textDocument: { uri: aliasDocument.uri },
      position: position(alias.startLine, alias.startColumn),
    }, signal));
    return dedupeLocations(target.length ? [...target, ...first] : first);
  }

  async references(relativePath: string, line: number, column: number, signal?: AbortSignal): Promise<CodeLocation[]> {
    const document = await this.openDocument(relativePath);
    const direct = this.normalizeLocations(await this.request('textDocument/references', {
      textDocument: { uri: document.uri },
      position: position(line, column),
      context: { includeDeclaration: true },
    }, signal));
    const definitions = await this.definition(relativePath, line, column, signal);
    const source = definitions.find((item) => item.path !== relativePath.replaceAll('\\', '/'));
    if (!source) return direct;
    const sourceDocument = await this.openDocument(source.path);
    const semantic = this.normalizeLocations(await this.request('textDocument/references', {
      textDocument: { uri: sourceDocument.uri },
      position: position(source.startLine, source.startColumn),
      context: { includeDeclaration: true },
    }, signal));
    return dedupeLocations([...semantic, ...direct]);
  }

  async diagnostics(relativePath: string, signal?: AbortSignal): Promise<CodeDiagnostic[]> {
    const document = await this.openDocument(relativePath);
    const existing = this.diagnosticsByUri.get(document.uri);
    if (existing) return structuredClone(existing);
    // 诊断由服务器异步推送：didOpen 后等待最多 5s，收到推送即提前返回，
    // 超时按空诊断处理而不是报错；signal 中止也走同一完成回调。
    await waitForDiagnostics(this.diagnosticWaiters, document.uri, signal, 5_000);
    return structuredClone(this.diagnosticsByUri.get(document.uri) ?? []);
  }

  async close(): Promise<void> {
    // 按 LSP 规范顺序关闭：先 shutdown、再发 exit 通知、最后断开连接；
    // 1s 内未自行退出则强杀子进程，避免残留 tsserver 占住文件句柄。
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
      connection.end();
      connection.dispose();
    }
    if (child) await stopChild(child);
  }

  private async openDocument(relativePath: string): Promise<OpenDocument> {
    await this.ensureStarted();
    const policy = await PathPolicy.create(this.workspaceRoot);
    this.workspaceCanonicalRoot ??= policy.workspaceRoot;
    const file = await policy.readTextFile(relativePath, 2 * 1024 * 1024);
    const normalized = path.relative(policy.workspaceRoot, file.canonicalPath).replaceAll('\\', '/');
    const uri = pathToFileURL(file.canonicalPath).href;
    const current = this.documents.get(normalized);
    // 语义分析要求服务器持有完整、最新的文件内容：首次打开推送 didOpen 并缓存，
    // 内容变化时递增版本推送 didChange，同时清掉旧诊断缓存。
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
    // 并发调用共享同一个 startup Promise，保证只拉起一次子进程。
    if (!this.startup) this.startup = this.start();
    return this.startup;
  }

  private async start(): Promise<void> {
    const executable = this.options.executable ?? process.execPath;
    const cliPath = this.options.cliPath ?? resolveLanguageServerCli();
    let child: ChildProcessWithoutNullStreams;
    try {
      // 外部进程隔离：argv 直接传给操作系统、不经过 shell，避免参数注入；
      // 并只透传白名单环境变量（safeProcessEnvironment），不继承会话凭据与代理配置。
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
    // tsserver 的日志走 stderr，直接丢弃以免积压阻塞子进程或被误当作协议输出。
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
      // 服务器推送的诊断按 URI 缓存；数量与单条消息长度都设上限，避免不可信大文本拖垮回填。
      const diagnostics = params.diagnostics.slice(0, 500)
        .map((value) => this.normalizeDiagnostic(params.uri, value))
        .filter(Boolean) as CodeDiagnostic[];
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
            diagnostic: { dynamicRegistration: false, relatedDocumentSupport: false },
            publishDiagnostics: { relatedInformation: true },
          },
        },
        initializationOptions: { preferences: { includeInlayParameterNameHints: 'none' } },
      }), this.options.requestTimeoutMs ?? 10_000);
      await connection.sendNotification('initialized', {});
    } catch {
      await this.close();
      // 初始化失败按可重试处理：复位 closed，允许后续调用重新拉起子进程。
      this.closed = false;
      throw new CodeIntelligenceError('lsp_unavailable', 'TypeScript Language Server 初始化失败');
    }
  }

  private async request(method: string, params: unknown, signal?: AbortSignal): Promise<unknown> {
    await this.ensureStarted();
    // 响应按 request id 由 vscode-jsonrpc 关联；取消/超时只影响当前请求（经
    // $/cancelRequest 通知服务器），共享的 LSP 会话保持可用。任何失败统一映射为
    // lsp_request_failed，由上层决定降级到 tree-sitter，不把原始 LSP 错误暴露出去。
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
      const workspaceRoot = this.workspaceCanonicalRoot ?? canonicalPath(this.workspaceRoot);
      const targetPath = canonicalPath(absolute);
      const relative = path.relative(workspaceRoot, targetPath);
      // LSP 返回的位置是不可信证据：工作区外的 URI 直接丢弃，只保留工作区内相对路径。
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

  private normalizeDiagnostic(uri: string, value: unknown): CodeDiagnostic | undefined {
    if (!isRecord(value) || !isRange(value.range) || typeof value.message !== 'string') return undefined;
    const target = this.locationFromUri(uri, value.range);
    if (!target) return undefined;
    const severity = value.severity === 1 ? 'error'
      : value.severity === 2 ? 'warning'
        : value.severity === 4 ? 'hint' : 'information';
    return {
      ...target,
      severity,
      message: value.message.slice(0, 2_000),
      source: 'lsp',
      code: typeof value.code === 'string' || typeof value.code === 'number' ? String(value.code) : undefined,
      evidenceId: `code:${createEvidenceId(`${target.path}:${target.startLine}:${target.startColumn}:${value.message}`)}`,
    };
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

function position(line: number, column: number): LspPosition {
  if (!Number.isInteger(line) || line < 1 || !Number.isInteger(column) || column < 1) {
    throw new CodeIntelligenceError('code_intelligence_failed', '行列必须从 1 开始');
  }
  // LSP 使用 0 基行列，本接口对外按 1 基约定，此处完成协议层转换。
  return { line: line - 1, character: column - 1 };
}

function isRange(value: unknown): value is LspRange {
  return isRecord(value) && isPosition(value.start) && isPosition(value.end);
}
function isPosition(value: unknown): value is LspPosition {
  return isRecord(value) && Number.isInteger(value.line) && Number.isInteger(value.character);
}
function isRecord(value: unknown): value is Record<string, any> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function languageId(relative: string): string {
  // jsx/tsx 必须映射到 React 方言的 languageId，tsserver 才能按 JSX 语法解析。
  if (/\.tsx$/iu.test(relative)) return 'typescriptreact';
  if (/\.jsx$/iu.test(relative)) return 'javascriptreact';
  if (/\.(?:js|mjs|cjs)$/iu.test(relative)) return 'javascript';
  return 'typescript';
}
function createEvidenceId(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 24);
}

function dedupeLocations(items: CodeLocation[]): CodeLocation[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = `${item.path}:${item.startLine}:${item.startColumn}:${item.endLine}:${item.endColumn}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function stopChild(child: ChildProcessWithoutNullStreams): Promise<void> {
  // typescript-language-server 会再拉起 tsserver 子进程；Windows 上必须整棵进程树终止，
  // 否则只杀包装进程会残留孤儿 tsserver。
  if (process.platform === 'win32' && child.pid) await terminateWindowsProcessTree(child.pid);
  if (child.exitCode === null && child.signalCode === null) child.kill();
  await waitForExit(child, 1_000);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL');
    await waitForExit(child, 1_000);
  }
  child.stdin.destroy();
  child.stdout.destroy();
  child.stderr.destroy();
}

async function terminateWindowsProcessTree(pid: number): Promise<void> {
  await new Promise<void>((resolve) => {
    let killer: ChildProcessWithoutNullStreams;
    try {
      killer = spawn('taskkill.exe', ['/pid', String(pid), '/t', '/f'], {
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch {
      resolve();
      return;
    }
    const done = () => resolve();
    killer.once('error', done);
    killer.once('exit', done);
    setTimeout(() => {
      if (killer.exitCode === null && killer.signalCode === null) killer.kill();
      resolve();
    }, 2_000).unref();
  });
}

async function waitForExit(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await Promise.race([
    new Promise<void>((resolve) => child.once('exit', () => resolve())),
    new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
}

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

function canonicalPath(value: string): string {
  try { return realpathSync.native(value); }
  catch { return path.resolve(value); }
}
