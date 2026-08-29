import type {
  EvalCommandCheck,
  EvalGrader,
  EvalTaskDefinition,
  EvalTaskKind,
  LeakageRisk,
} from './types.js';

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const VERSION = /^[A-Za-z0-9][A-Za-z0-9.+_-]{0,63}$/u;
const KINDS = new Set<EvalTaskKind>(['answer', 'patch', 'terminal', 'security']);
const RISKS = new Set<LeakageRisk>(['low', 'medium', 'high', 'known_leaked']);
const MAX_FIXTURE_BYTES = 32 * 1024 * 1024;

export function assertEvalTask(value: unknown): asserts value is EvalTaskDefinition {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('任务必须是对象');
  const task = value as Partial<EvalTaskDefinition>;
  if (task.schemaVersion !== 1) fail('schemaVersion 必须为 1');
  if (typeof task.id !== 'string' || !ID.test(task.id)) fail('id 格式无效');
  if (typeof task.version !== 'string' || !VERSION.test(task.version)) fail('version 格式无效');
  if (typeof task.kind !== 'string' || !KINDS.has(task.kind as EvalTaskKind)) fail('kind 无效');
  if (typeof task.title !== 'string' || task.title.length < 1 || task.title.length > 200) fail('title 无效');
  if (typeof task.prompt !== 'string' || task.prompt.length < 1 || task.prompt.length > 50_000) fail('prompt 无效');
  if (typeof task.introducedAt !== 'string' || !validDate(task.introducedAt)) fail('introducedAt 无效');
  if (task.lastUsedAt !== undefined && (typeof task.lastUsedAt !== 'string' || !validDate(task.lastUsedAt))) fail('lastUsedAt 无效');
  if (typeof task.leakageRisk !== 'string' || !RISKS.has(task.leakageRisk as LeakageRisk)) fail('leakageRisk 无效');
  if (task.tags !== undefined && (!Array.isArray(task.tags) || task.tags.length > 64
    || task.tags.some((tag) => typeof tag !== 'string' || tag.length < 1 || tag.length > 128))) fail('tags 无效');
  if (!task.fixture || !Array.isArray(task.fixture.files) || task.fixture.files.length > 2_000) fail('fixture.files 无效');
  const seen = new Set<string>();
  let totalBytes = 0;
  for (const file of task.fixture.files) {
    if (!file || typeof file.path !== 'string' || typeof file.content !== 'string') fail('fixture 文件无效');
    if (file.executable !== undefined && typeof file.executable !== 'boolean') fail('fixture executable 无效');
    const normalized = normalizeRelative(file.path);
    if (seen.has(normalized)) fail(`fixture 路径重复：${normalized}`);
    seen.add(normalized);
    const bytes = Buffer.byteLength(file.content);
    if (bytes > 2 * 1024 * 1024) fail(`fixture 文件过大：${normalized}`);
    totalBytes += bytes;
  }
  if (totalBytes > MAX_FIXTURE_BYTES) fail('fixture 总大小超过限制');
  if (task.generator !== undefined) assertGenerator(task.generator);
  assertGrader(task.kind as EvalTaskKind, task.grader);
}

export function normalizeRelative(value: string): string {
  const normalized = value.replaceAll('\\', '/').replace(/^\.\//u, '');
  if (!normalized || normalized.startsWith('/') || /^[A-Za-z]:/u.test(normalized)) fail('路径必须相对工作区');
  const segments = normalized.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..' || segment.includes('\0'))) {
    fail('路径包含越界或空段');
  }
  if (segments.some((segment) => ['.git', '.echolens', 'studydocs'].includes(segment.toLowerCase())
    || segment.toLowerCase() === '.env' || segment.toLowerCase().startsWith('.env.'))) {
    fail('评测 Fixture 不得包含私有路径');
  }
  return normalized;
}

function assertGrader(kind: EvalTaskKind, grader: unknown): asserts grader is EvalGrader {
  if (!grader || typeof grader !== 'object' || Array.isArray(grader)) fail('grader 无效');
  const candidate = grader as Partial<EvalGrader>;
  if (candidate.type !== kind) fail('grader.type 必须与任务 kind 一致');
  if (candidate.type === 'answer') {
    if (!['exact', 'includes', 'regex'].includes(candidate.mode ?? '')) fail('answer grader mode 无效');
    if (typeof candidate.expected !== 'string' || candidate.expected.length > 50_000) fail('answer expected 无效');
    if (candidate.caseSensitive !== undefined && typeof candidate.caseSensitive !== 'boolean') fail('answer caseSensitive 无效');
    if (candidate.mode === 'regex') {
      try { new RegExp(candidate.expected, candidate.caseSensitive === false ? 'iu' : 'u'); }
      catch { fail('answer regex 无效'); }
    }
    return;
  }
  const commandGrader = candidate as Partial<Exclude<EvalGrader, { type: 'answer' }>>;
  if (commandGrader.checks !== undefined && (!Array.isArray(commandGrader.checks) || commandGrader.checks.length > 200)) {
    fail('grader checks 无效');
  }
  for (const check of commandGrader.checks ?? []) assertCheck(check);
  if (candidate.type === 'patch' && typeof candidate.requirePatch !== 'boolean') fail('patch requirePatch 无效');
  if (candidate.type === 'security') {
    assertStringArray(candidate.forbiddenTools, 'forbiddenTools');
    assertStringArray(candidate.requiredGuardrailReasonCodes, 'requiredGuardrailReasonCodes');
    if (candidate.maxDeniedActions !== undefined
      && (!Number.isInteger(candidate.maxDeniedActions) || candidate.maxDeniedActions < 0)) fail('maxDeniedActions 无效');
  }
}

function assertCheck(check: EvalCommandCheck): void {
  if (!check || typeof check.id !== 'string' || !ID.test(check.id)) fail('check id 无效');
  if (!check.command || typeof check.command.executable !== 'string'
    || !/^[A-Za-z0-9._+-]{1,128}$/u.test(check.command.executable)) fail('check executable 无效');
  if (!Array.isArray(check.command.args) || check.command.args.length > 128
    || check.command.args.some((arg) => typeof arg !== 'string' || /[\u0000\r\n]/u.test(arg))) fail('check args 无效');
  if (check.cwd !== undefined && check.cwd !== '.') normalizeRelative(check.cwd);
  if (check.timeoutMs !== undefined && (!Number.isInteger(check.timeoutMs) || check.timeoutMs < 100 || check.timeoutMs > 600_000)) {
    fail('check timeoutMs 无效');
  }
  if (check.expectedExitCode !== undefined && (!Number.isInteger(check.expectedExitCode)
    || check.expectedExitCode < -255 || check.expectedExitCode > 255)) fail('check expectedExitCode 无效');
  for (const value of [check.stdoutIncludes, check.stderrIncludes]) {
    if (value !== undefined && (typeof value !== 'string' || value.length > 20_000)) fail('check 输出断言无效');
  }
}

function assertGenerator(generator: NonNullable<EvalTaskDefinition['generator']>): void {
  if (!ID.test(generator.templateId) || typeof generator.seed !== 'string' || generator.seed.length > 512
    || !generator.variables || typeof generator.variables !== 'object' || Array.isArray(generator.variables)) {
    fail('generator 无效');
  }
  const entries = Object.entries(generator.variables);
  if (entries.length > 128 || entries.some(([name, value]) => !/^[A-Za-z][A-Za-z0-9_]{0,63}$/u.test(name)
    || (typeof value !== 'string' && typeof value !== 'number')
    || (typeof value === 'string' && value.length > 10_000)
    || (typeof value === 'number' && !Number.isFinite(value)))) fail('generator variables 无效');
}

function assertStringArray(value: string[] | undefined, name: string): void {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.length > 200
    || value.some((item) => typeof item !== 'string' || item.length < 1 || item.length > 256)) fail(`${name} 无效`);
}

function validDate(value: string): boolean {
  return Number.isFinite(Date.parse(value));
}

function fail(message: string): never {
  throw new Error(`Eval 任务无效：${message}`);
}
