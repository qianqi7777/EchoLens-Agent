import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { IssueCase, IssueSet, ProviderConfig, ProviderIssueResult, ProviderSummary } from './types.js';

const MAX_OUTPUT = 64 * 1024;

export async function runComparison(
  issueSet: IssueSet,
  providers: ProviderConfig[],
  repoRoot: string,
  execute = false,
): Promise<ProviderSummary[]> {
  validateIssueSet(issueSet);
  if (execute && process.env.AGENT_TEST_ENABLE_EXTERNAL !== 'true') {
    throw new Error('真实 CLI 执行已锁定；请用 AGENT_TEST_ENABLE_EXTERNAL=true 启动服务');
  }
  const active = providers.filter((provider) => provider.enabled !== false);
  return Promise.all(active.map((provider) => runProvider(provider, issueSet, repoRoot, execute)));
}

async function runProvider(
  provider: ProviderConfig,
  issueSet: IssueSet,
  repoRoot: string,
  execute: boolean,
): Promise<ProviderSummary> {
  const results: ProviderIssueResult[] = [];
  for (const issue of issueSet.issues) {
    results.push(await runIssue(provider, issue, repoRoot, execute));
  }
  const duration = results.reduce((sum, result) => sum + result.durationMs, 0);
  const resolvedBugs = results.filter((result) => result.resolved).length;
  return {
    providerId: provider.id,
    label: provider.label,
    totalIssues: results.length,
    foundBugs: results.reduce((sum, result) => sum + result.foundBugs, 0),
    resolvedBugs,
    resolutionRate: results.length ? resolvedBugs / results.length : 0,
    averageDurationMs: results.length ? duration / results.length : 0,
    results,
  };
}

async function runIssue(
  provider: ProviderConfig,
  issue: IssueCase,
  repoRoot: string,
  execute: boolean,
): Promise<ProviderIssueResult> {
  const started = Date.now();
  if (!execute || provider.id === 'local-sim') {
    const found = /bug|修复|错误|失败/iu.test(`${issue.title} ${issue.body ?? ''}`) ? 1 : 0;
    return {
      providerId: provider.id,
      issueId: issue.id,
      mode: 'simulated',
      foundBugs: found,
      resolved: false,
      durationMs: 5,
      output: 'dry-run: local simulation',
    };
  }
  if (!provider.command) {
    return failure(provider, issue, started, '未配置 Provider command');
  }
  const worktree = await mkdtemp(path.join(tmpdir(), `echolens-agent-test-${issue.id}-`));
  try {
    await copyFixture(repoRoot, worktree);
    const prompt = `${issue.title}\n\n${issue.body ?? ''}`;
    const args = (provider.args ?? []).map((arg) => arg
      .replaceAll('{prompt}', prompt)
      .replaceAll('{repo}', worktree)
      .replaceAll('{issue}', issue.id));
    const command = await executeCommand(provider.command, args, worktree, 10 * 60_000);
    const foundBugs = parseFoundBugs(command.stdout);
    const hasChecks = Boolean(issue.checks?.length);
    const checks = hasChecks && await runChecks(issue, worktree);
    return {
      providerId: provider.id,
      issueId: issue.id,
      mode: 'executed',
      foundBugs,
      resolved: command.exitCode === 0 && !command.timedOut && checks,
      durationMs: Date.now() - started,
      exitCode: command.exitCode,
      timedOut: command.timedOut,
      output: command.stdout.slice(0, MAX_OUTPUT),
      error: command.stderr ? command.stderr.slice(0, 2_000) : undefined,
    };
  } catch (error) {
    return failure(provider, issue, started, error instanceof Error ? error.message : '执行失败');
  } finally {
    await rm(worktree, { recursive: true, force: true });
  }
}

async function copyFixture(source: string, target: string): Promise<void> {
  const files = await walk(source, source);
  for (const file of files) {
    const relative = path.relative(source, file);
    const destination = path.join(target, relative);
    const content = await readFile(file);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, content);
  }
}

async function walk(root: string, sourceRoot: string): Promise<string[]> {
  const entries = await import('node:fs/promises').then((fs) => fs.readdir(root, { withFileTypes: true }));
  const files: string[] = [];
  for (const entry of entries) {
    const target = path.join(root, entry.name);
    const relative = path.relative(sourceRoot, target);
    if (isPrivateOrGenerated(relative)) continue;
    if (entry.isDirectory()) files.push(...await walk(target, sourceRoot));
    else if (entry.isFile()) files.push(target);
  }
  return files;
}

function isPrivateOrGenerated(relative: string): boolean {
  const first = relative.split(path.sep)[0]?.toLowerCase();
  return ['.git', '.echolens', '.workbuddy', 'node_modules', 'dist', 'coverage', 'studydocs', 'agent-test'].includes(first ?? '')
    || relative === 'AGENTS.md'
    || path.basename(relative).startsWith('.env');
}

async function runChecks(issue: IssueCase, cwd: string): Promise<boolean> {
  for (const check of issue.checks ?? []) {
    const result = await executeCommand(check.command.executable, check.command.args, path.join(cwd, check.cwd ?? '.'), check.timeoutMs ?? 60_000);
    const expected = check.expectedExitCode ?? 0;
    if (result.exitCode !== expected || result.timedOut || (check.stdoutIncludes && !result.stdout.includes(check.stdoutIncludes))) return false;
  }
  return true;
}

function executeCommand(command: string, args: string[], cwd: string, timeoutMs: number): Promise<{ exitCode: number; stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, shell: false, windowsHide: true });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
    child.stdout.on('data', (chunk) => { stdout = `${stdout}${chunk}`.slice(-MAX_OUTPUT); });
    child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-MAX_OUTPUT); });
    child.on('error', (error) => { clearTimeout(timer); resolve({ exitCode: 1, stdout, stderr: error.message, timedOut }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ exitCode: code ?? 1, stdout, stderr, timedOut }); });
  });
}

function parseFoundBugs(output: string): number {
  try {
    const value = JSON.parse(output.trim()) as { foundBugs?: unknown };
    if (typeof value.foundBugs === 'number' && Number.isFinite(value.foundBugs)) return Math.max(0, Math.floor(value.foundBugs));
  } catch { /* plain CLI output is supported below */ }
  return (output.match(/\b(?:bug|issue|错误|缺陷)\b/giu) ?? []).length;
}

function failure(provider: ProviderConfig, issue: IssueCase, started: number, error: string): ProviderIssueResult {
  return { providerId: provider.id, issueId: issue.id, mode: 'executed', foundBugs: 0, resolved: false, durationMs: Date.now() - started, output: '', error };
}

function validateIssueSet(value: IssueSet): void {
  if (!value || typeof value.repo !== 'string' || !Array.isArray(value.issues)) throw new Error('Issue 数据格式无效');
  if (value.issues.length > 100) throw new Error('单次最多评测 100 个 Issue');
  for (const issue of value.issues) {
    if (!issue.id || !issue.title) throw new Error('Issue 缺少 id 或 title');
    if (issue.id.length > 200 || issue.title.length > 2_000 || (issue.body?.length ?? 0) > 100_000) {
      throw new Error('Issue 字段过长');
    }
    if ((issue.checks?.length ?? 0) > 50) throw new Error('Issue 验证命令过多');
  }
}
