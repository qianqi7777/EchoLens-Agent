import { chmod, lstat, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { PathPolicy, PathPolicyError } from '../../src/runtime/path-policy.js';
import { redactText } from '../../src/providers/redaction.js';
import { validateIssueSet } from './validation.js';
import { runLabProcess } from './process.js';
import type { IssueCase, IssueSet, ProviderConfig, ProviderIssueResult, ProviderSummary } from './types.js';

export async function runComparison(issueSet: IssueSet, providers: ProviderConfig[], repoRoot: string,
  execute = false, signal?: AbortSignal): Promise<ProviderSummary[]> {
  validateIssueSet(issueSet);
  if (execute && process.env.AGENT_TEST_ENABLE_EXTERNAL !== 'true') {
    throw new Error('真实 CLI 执行已锁定；请用 AGENT_TEST_ENABLE_EXTERNAL=true 启动服务');
  }
  const active = providers.filter((provider) => provider.enabled !== false);
  if (!active.length) throw new Error('至少选择一个 Provider');
  signal?.throwIfAborted();
  // Wait for cleanup from every provider before releasing the server's single-run slot.
  const outcomes = await Promise.allSettled(active.map(async (provider): Promise<ProviderSummary> => {
    const results: ProviderIssueResult[] = [];
    for (const issue of issueSet.issues) {
      signal?.throwIfAborted();
      results.push(await runIssue(provider, issue, repoRoot, execute, signal));
    }
    const resolvedBugs = results.filter((result) => result.resolved).length;
    return { providerId: provider.id, label: provider.label, totalIssues: results.length,
      foundBugs: results.reduce((sum, result) => sum + result.foundBugs, 0), resolvedBugs,
      resolutionRate: resolvedBugs / results.length,
      averageDurationMs: results.reduce((sum, result) => sum + result.durationMs, 0) / results.length, results };
  }));
  signal?.throwIfAborted();
  return outcomes.map((outcome) => {
    if (outcome.status === 'rejected') throw outcome.reason;
    return outcome.value;
  });
}

async function runIssue(provider: ProviderConfig, issue: IssueCase, repoRoot: string,
  execute: boolean, signal?: AbortSignal): Promise<ProviderIssueResult> {
  const started = Date.now();
  const base = { providerId: provider.id, issueId: issue.id, foundBugs: 0, resolved: false, durationMs: 0, output: '' };
  if (!execute || provider.id === 'local-sim') {
    return { ...base, mode: 'simulated', verification: 'simulated',
      foundBugs: /bug|修复|错误|失败/iu.test(`${issue.title} ${issue.body ?? ''}`) ? 1 : 0,
      output: '本地模拟：未启动 CLI、未执行验证；发现数仅来自题目关键词，不代表 Agent 能力。' };
  }
  let worktree: string | undefined;
  try {
    if (!provider.command) throw new Error('未配置 Provider command');
    worktree = await mkdtemp(path.join(tmpdir(), 'echolens-agent-test-'));
    await copyFixture(repoRoot, worktree, signal);
    const prompt = `${issue.title}\n\n${issue.body ?? ''}`;
    const args = (provider.args ?? []).map((arg) => arg.replaceAll('{prompt}', prompt)
      .replaceAll('{repo}', worktree!).replaceAll('{issue}', issue.id));
    const command = await runLabProcess(provider.command, args, worktree, 10 * 60_000, signal);
    const success = command.exitCode === 0 && !command.timedOut && !command.cancelled;
    const checks: NonNullable<ProviderIssueResult['checks']> = [];
    if (success) {
      for (const check of issue.checks ?? []) {
        signal?.throwIfAborted();
        const cwd = await realpath(path.resolve(worktree, check.cwd ?? '.'));
        assertInside(await realpath(worktree), cwd);
        const outcome = await runLabProcess(check.command.executable, check.command.args, cwd, check.timeoutMs ?? 60000, signal);
        checks.push({ id: check.id, exitCode: outcome.exitCode,
          passed: !outcome.timedOut && !outcome.cancelled && outcome.exitCode === (check.expectedExitCode ?? 0)
            && (!check.stdoutIncludes || outcome.stdout.includes(check.stdoutIncludes)),
          output: `${outcome.stdout}${outcome.stderr}${outcome.timedOut ? '\n验证超时' : ''}${outcome.truncated ? '\n[输出已截断]' : ''}` });
        if (!checks.at(-1)!.passed) break;
      }
    }
    const verified = Boolean(checks.length && checks.every((check) => check.passed));
    return { ...base, mode: 'executed', foundBugs: parseFoundBugs(command.stdout),
      resolved: success && verified, durationMs: Date.now() - started,
      exitCode: command.exitCode, timedOut: command.timedOut, cancelled: command.cancelled,
      outputTruncated: command.truncated, output: command.stdout, checks,
      verification: !success ? 'not-run' : !checks.length ? 'missing' : verified ? 'passed' : 'failed',
      error: command.cancelled ? '已取消' : command.timedOut ? 'CLI 执行超时' : command.stderr || (!success ? `CLI 退出码 ${command.exitCode}` : undefined),
    };
  } catch (error) {
    return { ...base, mode: 'executed', verification: 'not-run', durationMs: Date.now() - started,
      error: redactText(error instanceof Error ? error.message : '执行失败') };
  } finally {
    if (worktree) {
      assertInside(tmpdir(), worktree);
      await rm(worktree, { recursive: true, force: true });
    }
  }
}

const PRIVATE_NAMES = new Set(['.git', '.echolens', '.workbuddy', '.codex', '.agents', '.ssh',
  'node_modules', 'dist', 'build', 'coverage', 'studydoc', 'studydocs', 'agent-test', 'agents.md']);
function isPublic(relative: string): boolean {
  return !relative.split(/[\\/]/u).some((name) => PRIVATE_NAMES.has(name.toLowerCase())
    || name.toLowerCase().startsWith('.env') || /\.(?:pem|key|pfx)$/iu.test(name));
}

async function copyFixture(source: string, target: string, signal?: AbortSignal): Promise<void> {
  const policy = await PathPolicy.create(source);
  let files: string[];
  try {
    const result = await promisify(execFile)('git', ['-C', source, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'],
      { windowsHide: true, maxBuffer: 4 * 1024 * 1024, timeout: 10000, signal });
    files = result.stdout.split('\0').filter(Boolean);
  } catch {
    signal?.throwIfAborted();
    if (await lstat(path.join(source, '.git')).then(() => true, () => false)) throw new Error('无法读取 Git 文件清单，拒绝忽略私有文件规则');
    files = await walk(policy, '.', signal);
  }
  files = [...new Set(files)].filter(isPublic);
  if (files.length > 20000) throw new Error('副本文件数超过 20000');
  let total = 0;
  for (const file of files) {
    signal?.throwIfAborted();
    const data = await policy.readFileBytes(file, 2 * 1024 * 1024).catch((error) => {
      if (error instanceof PathPolicyError && error.code === 'path_not_found') return undefined;
      throw error;
    });
    if (!data) continue;
    total += data.bytes.length;
    if (total > 64 * 1024 * 1024) throw new Error('副本大小超过 64 MiB');
    const destination = path.resolve(target, file);
    assertInside(target, destination);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, data.bytes);
    const info = await policy.resolveExisting(file, 'file');
    if (Number(info.stat.mode) & 0o111) await chmod(destination, 0o755);
  }
}

async function walk(policy: PathPolicy, directory: string, signal?: AbortSignal): Promise<string[]> {
  signal?.throwIfAborted();
  const result: string[] = [];
  for (const entry of (await policy.readDirectory(directory)).entries) {
    const relative = path.join(directory, entry.name);
    if (!isPublic(relative) || entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) result.push(...await walk(policy, relative, signal));
    else if (entry.isFile()) result.push(relative);
    if (result.length > 20000) throw new Error('副本文件数超过 20000');
  }
  return result;
}

export function assertInside(root: string, target: string): void {
  const relative = path.relative(root, target);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('路径越出允许的工作目录');
}

function parseFoundBugs(output: string): number {
  try {
    const value = JSON.parse(output.trim()) as { foundBugs?: unknown };
    if (typeof value?.foundBugs === 'number' && Number.isFinite(value.foundBugs)) return Math.max(0, Math.floor(value.foundBugs));
  } catch { /* Legacy CLI output uses a clearly labeled heuristic count. */ }
  return (output.match(/\b(?:bug|issue)\b|错误|缺陷/giu) ?? []).length;
}
