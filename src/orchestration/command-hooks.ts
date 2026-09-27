import { createHash, randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { statSync } from 'node:fs';
import { lstat, mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import * as path from 'node:path';
import Ajv from 'ajv';
import type { Permission } from '../core/permissions.js';
import type { ToolEffect } from '../runtime/action-guardrail.js';
import type { ToolResult } from '../runtime/types.js';
import { withFileLock } from '../runtime/file-lock.js';

export type HookScope = 'user' | 'project';
export type HookEventName =
  | 'SessionStart'
  | 'UserPromptSubmit'
  | 'PreToolUse'
  | 'PostToolUse'
  | 'Stop'
  | 'SessionEnd';

const HOOK_EVENTS: readonly HookEventName[] = [
  'SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'SessionEnd',
];
const DECISION_EVENTS = new Set<HookEventName>(['UserPromptSubmit', 'PreToolUse']);
const MAX_CONFIG_BYTES = 256 * 1024;
const MAX_HOOKS = 64;
const MAX_OUTPUT_BYTES = 32 * 1024;
const MAX_CONTEXT_BYTES = 8 * 1024;
const MAX_TRUST_FILE_BYTES = 1024 * 1024;
const MAX_TRUST_FILES_BYTES = 8 * 1024 * 1024;
const MAX_REASON_CHARS = 2_000;
const DEFAULT_TIMEOUT_MS = 5_000;

export interface CommandHookResult {
  hookId: string;
  status: 'completed' | 'denied' | 'timeout' | 'failed' | 'cancelled' | 'skipped';
  reasonCode: string;
  durationMs: number;
  scope: HookScope;
  hookEventName: HookEventName;
}

export interface HookInput {
  version: 1;
  hookEventName: HookEventName;
  invocationId?: string;
  sessionId: string;
  turnId?: string;
  runId?: string;
  cwd: string;
  timestamp?: string;
  source?: 'startup' | 'resume' | 'workspace_switch' | 'close';
  prompt?: string;
  callId?: string;
  toolName?: string;
  permission?: Permission;
  effect?: ToolEffect;
  toolInput?: Record<string, unknown>;
  toolResult?: ToolResult;
  state?: string;
  degraded?: boolean;
  answer?: string;
}

export interface HookContext {
  hookId: string;
  scope: HookScope;
  content: string;
  contentHash: string;
}

export interface HookRunResult {
  decision: 'continue' | 'deny';
  reason?: string;
  contexts: HookContext[];
  results: CommandHookResult[];
}

export interface HookStatus {
  id: string;
  runtimeId: string;
  scope: HookScope;
  event: HookEventName;
  enabled: boolean;
  trusted: boolean;
  fingerprint?: string;
  executable: string;
}

export interface CommandHookManagerOptions {
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
}

interface HookMatcherConfig { tools: string[] }
interface HookHandlerConfig {
  type: 'command';
  executable: string;
  args?: string[];
  timeoutMs?: number;
  envFrom?: string[];
}
interface HookDefinitionConfig {
  id: string;
  enabled?: boolean;
  matcher?: HookMatcherConfig;
  handler: HookHandlerConfig;
  failureMode?: 'open' | 'closed';
  trustFiles?: string[];
}
interface HookConfigFile {
  version: 1;
  hooks: Partial<Record<HookEventName, HookDefinitionConfig[]>>;
}
interface LoadedHook extends HookDefinitionConfig {
  scope: HookScope;
  event: HookEventName;
  runtimeId: string;
  fingerprint?: string;
}
interface TrustFile { version: 1; trusted: Record<string, string> }
interface CommandOutcome {
  kind: 'completed' | 'denied' | 'timeout' | 'failed' | 'cancelled';
  reasonCode: string;
  reason?: string;
  additionalContext?: string;
}

const hookEntrySchema = {
  type: 'object', required: ['id', 'handler'], additionalProperties: false,
  properties: {
    id: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$' },
    enabled: { type: 'boolean' },
    matcher: {
      type: 'object', required: ['tools'], additionalProperties: false,
      properties: {
        tools: { type: 'array', minItems: 1, maxItems: 128, uniqueItems: true,
          items: { type: 'string', minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9_.*?-]+$' } },
      },
    },
    handler: {
      type: 'object', required: ['type', 'executable'], additionalProperties: false,
      properties: {
        type: { const: 'command' },
        executable: { type: 'string', minLength: 1, maxLength: 4096, pattern: '^[^\\u0000\\r\\n]+$' },
        args: { type: 'array', maxItems: 128,
          items: { type: 'string', maxLength: 8192, pattern: '^[^\\u0000\\r\\n]*$' } },
        timeoutMs: { type: 'integer', minimum: 100, maximum: 30_000 },
        envFrom: { type: 'array', maxItems: 32, uniqueItems: true,
          items: { type: 'string', pattern: '^[A-Za-z_][A-Za-z0-9_]{0,127}$' } },
      },
    },
    failureMode: { enum: ['open', 'closed'] },
    trustFiles: { type: 'array', maxItems: 64, uniqueItems: true,
      items: { type: 'string', minLength: 1, maxLength: 4096, pattern: '^[^\\u0000\\r\\n]+$' } },
  },
} as const;

const configSchema = {
  type: 'object', required: ['version', 'hooks'], additionalProperties: false,
  properties: {
    version: { const: 1 },
    hooks: {
      type: 'object', additionalProperties: false,
      properties: Object.fromEntries(HOOK_EVENTS.map((event) => [event, {
        type: 'array', maxItems: MAX_HOOKS, items: hookEntrySchema,
      }])),
    },
  },
} as const;
const validateConfig = new Ajv({ allErrors: true, strict: true }).compile(configSchema);

export class HookConfigError extends Error {
  readonly code = 'hook_config_invalid';
  constructor(message: string) { super(message); this.name = 'HookConfigError'; }
}

/** Loads, trusts, and executes command hooks for one workspace. */
export class CommandHookManager {
  private readonly env: NodeJS.ProcessEnv;
  private readonly now: () => Date;
  private readonly userConfigPath: string;
  private readonly projectConfigPath: string;
  private readonly trustPath: string;
  private hooks: LoadedHook[] = [];
  private trust: TrustFile = { version: 1, trusted: {} };

  private constructor(readonly workspaceRoot: string, options: CommandHookManagerOptions) {
    this.env = options.env ?? process.env;
    this.now = options.now ?? (() => new Date());
    const home = this.env.ECHOLENS_HOME?.trim() || path.join(homedir(), '.echolens');
    this.userConfigPath = path.resolve(home, 'hooks.json');
    this.projectConfigPath = path.resolve(workspaceRoot, '.echolens', 'hooks.json');
    this.trustPath = path.resolve(workspaceRoot, '.echolens', 'hook-trust.json');
  }

  static async load(workspaceRoot: string, options: CommandHookManagerOptions = {}): Promise<CommandHookManager> {
    const manager = new CommandHookManager(path.resolve(workspaceRoot), options);
    await manager.reload();
    return manager;
  }

  async run(input: HookInput, signal = new AbortController().signal): Promise<HookRunResult> {
    const normalized: HookInput = {
      ...structuredClone(input), version: 1,
      invocationId: input.invocationId ?? randomUUID(),
      timestamp: input.timestamp ?? this.now().toISOString(),
    };
    const matches = this.hooks.filter((hook) => hook.event === input.hookEventName
      && hook.enabled !== false && matchesHook(hook, input));
    const results: CommandHookResult[] = [];
    const contexts: HookContext[] = [];
    let contextBytes = 0;
    let denialReason: string | undefined;
    for (const hook of matches) {
      if (hook.scope === 'project') {
        try { hook.fingerprint = await projectFingerprint(hook, this.workspaceRoot); }
        catch {
          results.push(resultFor(hook, 'failed', 'hook_fingerprint_failed', 0));
          if (DECISION_EVENTS.has(hook.event) && hookFailureClosed(hook)) {
            denialReason ??= `Hook ${hook.runtimeId} 信任文件校验失败，已按 fail-closed 拒绝`;
          }
          continue;
        }
        if (this.trust.trusted[hook.id] !== hook.fingerprint) {
          results.push(resultFor(hook, 'skipped', 'project_hook_not_trusted', 0));
          continue;
        }
      }
      const started = performance.now();
      let outcome = await executeCommandHook(hook, normalized, this.workspaceRoot, this.env, signal);
      if (outcome.additionalContext) {
        const bytes = Buffer.byteLength(outcome.additionalContext, 'utf8');
        if (contextBytes + bytes > MAX_CONTEXT_BYTES) {
          outcome = { kind: 'failed', reasonCode: 'hook_context_too_large' };
        } else {
          contextBytes += bytes;
        }
      }
      const durationMs = Math.max(0, Math.round(performance.now() - started));
      results.push(resultFor(hook, outcome.kind, outcome.reasonCode, durationMs));
      if (outcome.additionalContext) {
        contexts.push({
          hookId: hook.runtimeId, scope: hook.scope, content: outcome.additionalContext,
          contentHash: `sha256:${createHash('sha256').update(outcome.additionalContext).digest('hex')}`,
        });
      }
      if (outcome.kind === 'denied') denialReason ??= outcome.reason ?? 'Hook 拒绝了当前动作';
      else if (DECISION_EVENTS.has(hook.event) && hookFailureClosed(hook) && outcome.kind !== 'completed') {
        denialReason ??= `Hook ${hook.runtimeId} 执行失败，已按 fail-closed 拒绝`;
      }
    }
    return { decision: denialReason ? 'deny' : 'continue', reason: denialReason, contexts, results };
  }

  async reload(): Promise<string[]> {
    const [user, project, trust] = await Promise.all([
      loadConfig(this.userConfigPath, 'user', this.workspaceRoot),
      loadConfig(this.projectConfigPath, 'project', this.workspaceRoot),
      loadTrust(this.trustPath),
    ]);
    if (user.length + project.length > MAX_HOOKS) throw new HookConfigError(`Hook 总数不能超过 ${MAX_HOOKS}`);
    this.hooks = [...user, ...project];
    this.trust = trust;
    return this.summary();
  }

  list(): HookStatus[] {
    return this.hooks.map((hook) => ({
      id: hook.id, runtimeId: hook.runtimeId, scope: hook.scope, event: hook.event,
      enabled: hook.enabled !== false,
      trusted: hook.scope === 'user' || this.trust.trusted[hook.id] === hook.fingerprint,
      fingerprint: hook.fingerprint, executable: hook.handler.executable,
    }));
  }

  summary(): string[] {
    const statuses = this.list();
    const active = statuses.filter((item) => item.enabled && item.trusted).length;
    const pending = statuses.filter((item) => item.enabled && !item.trusted).length;
    return [`Hook 已加载 ${statuses.length} 个，启用 ${active} 个，待信任 ${pending} 个`];
  }

  async trustProject(selector: string): Promise<string[]> {
    const selected = this.hooks.filter((hook) => hook.scope === 'project'
      && (selector === 'all' || hook.id === selector));
    if (selected.length === 0) throw new Error(`未找到项目 Hook：${selector}`);
    for (const hook of selected) {
      hook.fingerprint = await projectFingerprint(hook, this.workspaceRoot);
      this.trust.trusted[hook.id] = hook.fingerprint;
    }
    await writeTrust(this.trustPath, this.trust);
    return selected.map((hook) => `已信任 ${hook.runtimeId} fingerprint=${shortHash(hook.fingerprint!)}`);
  }

  async revokeProject(selector: string): Promise<string[]> {
    const selected = this.hooks.filter((hook) => hook.scope === 'project'
      && (selector === 'all' || hook.id === selector));
    if (selected.length === 0) throw new Error(`未找到项目 Hook：${selector}`);
    for (const hook of selected) delete this.trust.trusted[hook.id];
    await writeTrust(this.trustPath, this.trust);
    return selected.map((hook) => `已撤销 ${hook.runtimeId}`);
  }
}

async function loadConfig(configPath: string, scope: HookScope, workspaceRoot: string): Promise<LoadedHook[]> {
  let bytes: Buffer;
  try {
    const info = await lstat(configPath);
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_CONFIG_BYTES) {
      throw new HookConfigError(`Hook 配置必须是普通小文件：${configPath}`);
    }
    bytes = await readFile(configPath);
    if (scope === 'project') {
      const [canonicalRoot, canonicalConfig] = await Promise.all([realpath(workspaceRoot), realpath(configPath)]);
      assertInside(canonicalRoot, canonicalConfig);
    }
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return [];
    throw error;
  }
  let parsed: unknown;
  try { parsed = JSON.parse(bytes.toString('utf8')); }
  catch { throw new HookConfigError(`Hook 配置不是有效 JSON：${configPath}`); }
  if (!validateConfig(parsed)) {
    const issue = validateConfig.errors?.[0];
    throw new HookConfigError(`Hook 配置不符合 Schema：${issue?.instancePath || '/'} ${issue?.message || ''}`.trim());
  }
  const config = parsed as HookConfigFile;
  const hooks: LoadedHook[] = [];
  const ids = new Set<string>();
  for (const event of HOOK_EVENTS) {
    for (const definition of config.hooks[event] ?? []) {
      if (ids.has(definition.id)) throw new HookConfigError(`Hook ID 重复：${scope}:${definition.id}`);
      ids.add(definition.id);
      if (definition.matcher && !['PreToolUse', 'PostToolUse'].includes(event)) {
        throw new HookConfigError(`只有工具事件可配置 matcher：${scope}:${definition.id}`);
      }
      const loaded: LoadedHook = {
        ...structuredClone(definition), scope, event, runtimeId: `${scope}:${definition.id}`,
      };
      if (scope === 'project') loaded.fingerprint = await projectFingerprint(loaded, workspaceRoot);
      hooks.push(loaded);
    }
  }
  return hooks;
}

async function projectFingerprint(hook: LoadedHook, workspaceRoot: string): Promise<string> {
  const canonicalRoot = await realpath(workspaceRoot);
  const hashes: Array<{ path: string; hash: string }> = [];
  let totalBytes = 0;
  for (const relativePath of hook.trustFiles ?? []) {
    const target = path.resolve(canonicalRoot, relativePath);
    assertInside(canonicalRoot, target);
    let info;
    try { info = await lstat(target); }
    catch (error) {
      if (isNodeError(error, 'ENOENT')) throw new HookConfigError(`trustFiles 不存在：${relativePath}`);
      throw error;
    }
    if (!info.isFile() || info.isSymbolicLink()) throw new HookConfigError(`trustFiles 必须是普通文件：${relativePath}`);
    if (info.size > MAX_TRUST_FILE_BYTES || totalBytes + info.size > MAX_TRUST_FILES_BYTES) {
      throw new HookConfigError(`trustFiles 超过大小上限：${relativePath}`);
    }
    totalBytes += info.size;
    const canonical = await realpath(target);
    assertInside(canonicalRoot, canonical);
    hashes.push({
      path: path.relative(canonicalRoot, canonical).replaceAll('\\', '/'),
      hash: createHash('sha256').update(await readFile(canonical)).digest('hex'),
    });
  }
  const commandCandidate = hook.handler.executable.includes('/') || hook.handler.executable.includes('\\')
    ? [hook.handler.executable] : [];
  const entryCandidate = [...commandCandidate, ...(hook.handler.args ?? [])]
    .find((argument) => isWorkspaceFile(argument, canonicalRoot));
  if (entryCandidate && !(hook.trustFiles ?? []).some((item) => sameRelativePath(item, entryCandidate))) {
    throw new HookConfigError(`项目 Hook 入口脚本必须列入 trustFiles：${hook.runtimeId} -> ${entryCandidate}`);
  }
  const canonicalDefinition = {
    id: hook.id, enabled: hook.enabled ?? true, event: hook.event,
    matcher: hook.matcher, handler: hook.handler,
    failureMode: hook.failureMode ?? (DECISION_EVENTS.has(hook.event) ? 'closed' : 'open'),
    trustFiles: hashes.sort((left, right) => left.path.localeCompare(right.path)),
  };
  return `sha256:${createHash('sha256').update(stableJson(canonicalDefinition)).digest('hex')}`;
}

async function loadTrust(filePath: string): Promise<TrustFile> {
  try {
    const value = JSON.parse(await readFile(filePath, 'utf8')) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    const candidate = value as Partial<TrustFile>;
    if (candidate.version !== 1 || !candidate.trusted || typeof candidate.trusted !== 'object'
      || Array.isArray(candidate.trusted)
      || Object.entries(candidate.trusted).some(([id, hash]) => !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(id)
        || typeof hash !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(hash))) throw new Error();
    return { version: 1, trusted: { ...candidate.trusted } } as TrustFile;
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return { version: 1, trusted: {} };
    throw new HookConfigError(`Hook 信任记录无效：${filePath}`);
  }
}

async function writeTrust(filePath: string, trust: TrustFile): Promise<void> {
  await withFileLock(`${filePath}.lock`, async () => {
    await mkdir(path.dirname(filePath), { recursive: true });
    const temporary = `${filePath}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(trust)}\n`, { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, filePath);
  });
}

async function executeCommandHook(
  hook: LoadedHook,
  input: HookInput,
  workspaceRoot: string,
  sourceEnv: NodeJS.ProcessEnv,
  signal: AbortSignal,
): Promise<CommandOutcome> {
  const result = await runChild({
    executable: resolveExecutable(hook.handler.executable, workspaceRoot),
    args: hook.handler.args ?? [], cwd: workspaceRoot,
    env: sanitizedEnvironment(hook, input, workspaceRoot, sourceEnv),
    stdin: `${JSON.stringify(input)}\n`,
    timeoutMs: hook.handler.timeoutMs ?? DEFAULT_TIMEOUT_MS, signal,
  });
  if (result.cancelled) return { kind: 'cancelled', reasonCode: 'hook_cancelled' };
  if (result.timedOut) return { kind: 'timeout', reasonCode: 'hook_timeout' };
  if (result.spawnError) return { kind: 'failed', reasonCode: 'hook_spawn_failed' };
  if (result.outputTruncated) return { kind: 'failed', reasonCode: 'hook_output_too_large' };
  if (result.exitCode === 2) {
    if (!DECISION_EVENTS.has(hook.event)) return { kind: 'failed', reasonCode: 'hook_deny_not_supported' };
    return { kind: 'denied', reasonCode: 'hook_denied', reason: boundedReason(result.stderr) };
  }
  if (result.exitCode !== 0) return { kind: 'failed', reasonCode: 'hook_exit_nonzero' };
  if (!result.stdout.trim()) return { kind: 'completed', reasonCode: 'hook_completed' };
  let output: unknown;
  try { output = JSON.parse(result.stdout); }
  catch { return { kind: 'failed', reasonCode: 'hook_output_invalid_json' }; }
  const parsed = parseHookOutput(output, hook.event);
  if (!parsed) return { kind: 'failed', reasonCode: 'hook_output_invalid' };
  return parsed.decision === 'deny'
    ? { kind: 'denied', reasonCode: 'hook_denied', reason: parsed.reason }
    : { kind: 'completed', reasonCode: 'hook_completed', additionalContext: parsed.additionalContext };
}

function parseHookOutput(
  value: unknown,
  event: HookEventName,
): { decision?: 'deny'; reason?: string; additionalContext?: string } | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const output = value as Record<string, unknown>;
  if (output.version !== 1
    || Object.keys(output).some((key) => !['version', 'decision', 'reason', 'additionalContext'].includes(key))) return undefined;
  if (output.decision !== undefined && output.decision !== 'deny') return undefined;
  if (output.decision === 'deny' && !DECISION_EVENTS.has(event)) return undefined;
  if (output.reason !== undefined && (typeof output.reason !== 'string' || output.reason.length > MAX_REASON_CHARS)) return undefined;
  if (output.decision === 'deny' && (!output.reason || typeof output.reason !== 'string')) return undefined;
  if (output.additionalContext !== undefined && (event !== 'UserPromptSubmit'
    || typeof output.additionalContext !== 'string'
    || Buffer.byteLength(output.additionalContext, 'utf8') > MAX_CONTEXT_BYTES)) return undefined;
  return {
    decision: output.decision as 'deny' | undefined,
    reason: output.reason as string | undefined,
    additionalContext: output.additionalContext as string | undefined,
  };
}

interface ChildRequest {
  executable: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdin: string;
  timeoutMs: number;
  signal: AbortSignal;
}
interface ChildResult {
  exitCode?: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  cancelled: boolean;
  outputTruncated: boolean;
  spawnError?: string;
}

function runChild(request: ChildRequest): Promise<ChildResult> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(request.executable, request.args, {
        cwd: request.cwd, env: request.env, shell: false, windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32',
      });
    } catch (error) {
      resolve({ stdout: '', stderr: '', timedOut: false, cancelled: false, outputTruncated: false,
        spawnError: error instanceof Error ? error.name : 'spawn_failed' });
      return;
    }
    const output = boundedOutput(MAX_OUTPUT_BYTES);
    let timedOut = false;
    let cancelled = false;
    let spawnError: string | undefined;
    let settled = false;
    let forceTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (exitCode?: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (forceTimer) clearTimeout(forceTimer);
      request.signal.removeEventListener('abort', abort);
      resolve({ exitCode, stdout: output.stdout(), stderr: output.stderr(), timedOut, cancelled,
        outputTruncated: output.truncated(), spawnError });
    };
    const terminate = () => {
      terminateProcessTree(child);
      forceTimer = setTimeout(() => finish(), 750);
    };
    const abort = () => { cancelled = true; terminate(); };
    const timer = setTimeout(() => { timedOut = true; terminate(); }, request.timeoutMs);
    child.stdout?.on('data', (chunk) => output.append('stdout', Buffer.from(chunk)));
    child.stderr?.on('data', (chunk) => output.append('stderr', Buffer.from(chunk)));
    child.once('error', (error) => { spawnError = error.name; finish(); });
    child.once('close', (code) => finish(code ?? undefined));
    if (request.signal.aborted) abort();
    else request.signal.addEventListener('abort', abort, { once: true });
    child.stdin?.on('error', () => undefined);
    child.stdin?.end(request.stdin);
  });
}

function terminateProcessTree(child: ChildProcess): void {
  if (!child.pid) { child.kill(); return; }
  if (process.platform === 'win32') {
    child.kill();
    const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
      shell: false, windowsHide: true, stdio: 'ignore',
    });
    killer.once('error', () => undefined);
    killer.unref();
  } else {
    try { process.kill(-child.pid, 'SIGKILL'); }
    catch { child.kill('SIGKILL'); }
  }
}

function boundedOutput(limit: number) {
  const chunks = { stdout: [] as Buffer[], stderr: [] as Buffer[] };
  let remaining = limit;
  let truncated = false;
  return {
    append(stream: 'stdout' | 'stderr', bytes: Buffer) {
      if (remaining <= 0) { truncated = true; return; }
      const accepted = bytes.subarray(0, remaining);
      chunks[stream].push(accepted);
      remaining -= accepted.byteLength;
      if (accepted.byteLength < bytes.byteLength) truncated = true;
    },
    stdout: () => Buffer.concat(chunks.stdout).toString('utf8'),
    stderr: () => Buffer.concat(chunks.stderr).toString('utf8'),
    truncated: () => truncated,
  };
}

function sanitizedEnvironment(
  hook: LoadedHook,
  input: HookInput,
  workspaceRoot: string,
  source: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'HOME', 'USERPROFILE']) {
    if (source[name] !== undefined) env[name] = source[name];
  }
  for (const name of hook.handler.envFrom ?? []) if (source[name] !== undefined) env[name] = source[name];
  env.ECHOLENS_PROJECT_DIR = workspaceRoot;
  env.ECHOLENS_SESSION_ID = input.sessionId;
  env.ECHOLENS_HOOK_EVENT = input.hookEventName;
  return env;
}

function matchesHook(hook: LoadedHook, input: HookInput): boolean {
  if (!hook.matcher) return true;
  return Boolean(input.toolName && hook.matcher.tools.some((pattern) => globMatches(pattern, input.toolName!)));
}

function globMatches(pattern: string, value: string): boolean {
  const tokens = pattern.split(/([*?])/u).map((part) => part === '*'
    ? '.*' : part === '?' ? '.' : part.replace(/[\\^$+?.()|{}[\]]/gu, '\\$&'));
  return new RegExp(`^${tokens.join('')}$`, 'u').test(value);
}

function hookFailureClosed(hook: LoadedHook): boolean {
  return hook.failureMode === 'closed' || (hook.failureMode === undefined && DECISION_EVENTS.has(hook.event));
}

function resultFor(
  hook: LoadedHook,
  status: CommandOutcome['kind'] | 'skipped',
  reasonCode: string,
  durationMs: number,
): CommandHookResult {
  return { hookId: hook.runtimeId, scope: hook.scope, hookEventName: hook.event, status, reasonCode, durationMs };
}

function resolveExecutable(executable: string, workspaceRoot: string): string {
  return executable.includes('/') || executable.includes('\\')
    ? path.resolve(workspaceRoot, executable) : executable;
}

function isWorkspaceFile(value: string, workspaceRoot: string): boolean {
  if (!value || value.startsWith('-') || path.isAbsolute(value)) return false;
  const relative = path.relative(workspaceRoot, path.resolve(workspaceRoot, value));
  if (relative.startsWith('..') || path.isAbsolute(relative)) return false;
  try { return statSync(path.resolve(workspaceRoot, value)).isFile(); }
  catch { return false; }
}

function sameRelativePath(left: string, right: string): boolean {
  const normalize = (value: string) => value.replaceAll('\\', '/').replace(/^\.\//u, '').toLowerCase();
  return normalize(left) === normalize(right);
}

function assertInside(root: string, candidate: string): void {
  const relative = path.relative(root, candidate);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new HookConfigError('Hook trustFiles 路径越界');
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>).sort().map((key) =>
      `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function boundedReason(stderr: string): string {
  const value = stderr.trim();
  return value ? value.slice(0, MAX_REASON_CHARS) : 'Hook 拒绝了当前动作';
}

function shortHash(value: string): string { return value.slice('sha256:'.length, 'sha256:'.length + 12); }
function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === code;
}
