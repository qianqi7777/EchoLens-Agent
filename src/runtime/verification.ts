import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { redactText } from '../providers/redaction.js';

export type VerificationStatus = 'passed' | 'failed' | 'skipped' | 'timeout';

export interface VerificationCommand {
  id: string;
  label: string;
  command: string;
  executable: string;
  args: readonly string[];
  cwd?: string;
  timeoutMs?: number;
  required?: boolean;
}

export interface EditVerificationResult {
  id: string;
  label: string;
  command: string;
  status: VerificationStatus;
  exitCode?: number;
  durationMs: number;
  summary: string;
  output?: string;
}

export interface VerificationPlan {
  commands: readonly VerificationCommand[];
  reason: string;
}

export interface VerificationRunOptions {
  signal?: AbortSignal;
  runCommand?: (command: VerificationCommand, signal?: AbortSignal) => Promise<EditVerificationResult>;
}

// 依据改动文件挑选最少的验证项：改动含 TS 时跑 typecheck，含测试或配置( package.json/tsconfig )变更时跑 test；
// 都匹配不到时才回退到 test，避免每次改动都无条件跑全套脚本。
export async function selectVerificationPlan(
  workspaceRoot: string,
  changedFiles: readonly string[],
): Promise<VerificationPlan> {
  const scripts = await packageScripts(workspaceRoot);
  const commands: VerificationCommand[] = [];
  const hasTypeScript = changedFiles.some((file) => /\.(?:ts|tsx)$/iu.test(file));
  const hasTests = changedFiles.some((file) => /(?:^|\/)(?:test|tests|__tests__)(?:\/|\.)|\.test\.[cm]?[jt]sx?$/iu.test(file));
  if (hasTypeScript && scripts.typecheck) commands.push(npmScript('typecheck', 'TypeScript 类型检查', workspaceRoot, true));
  if ((hasTests || changedFiles.some((file) => /(?:package\.json|tsconfig\.json)$/iu.test(file))) && scripts.test) {
    commands.push(npmScript('test', '项目测试', workspaceRoot, true, 120_000));
  }
  if (commands.length === 0 && scripts.test) commands.push(npmScript('test', '项目测试', workspaceRoot, false, 120_000));
  return { commands, reason: commands.length ? '根据改动文件选择验证项' : '未找到可安全自动运行的验证脚本' };
}

// 按顺序执行；任一 required 命令失败则跳过其后所有命令，避免在已知失败基础上继续输出误导性结果。
// 各处取消（signal.aborted）统一标记为 skipped，不当作失败计入。
export async function runVerification(
  plan: VerificationPlan,
  options: VerificationRunOptions = {},
): Promise<EditVerificationResult[]> {
  const results: EditVerificationResult[] = [];
  for (const command of plan.commands) {
    if (options.signal?.aborted) {
      results.push({ id: command.id, label: command.label, command: command.command, status: 'skipped', durationMs: 0, summary: '验证因取消而未运行' });
      continue;
    }
    const result = await (options.runCommand ?? runCommand)(command, options.signal);
    results.push(result);
    if (result.status !== 'passed' && command.required) {
      for (const remaining of plan.commands.slice(results.length)) {
        results.push({ id: remaining.id, label: remaining.label, command: remaining.command, status: 'skipped', durationMs: 0, summary: '前置验证失败，未运行' });
      }
      break;
    }
  }
  return results;
}

async function runCommand(command: VerificationCommand, signal?: AbortSignal): Promise<EditVerificationResult> {
  const started = Date.now();
  return new Promise((resolve) => {
    // shell:false 让参数以 argv 数组传递、不经过 shell 解析，防止命令字符串被注入；
    // 输出统一脱敏并截断到最近 4000 字符，避免验证脚本的敏感内容外泄。
    const child = spawn(command.executable, [...command.args], {
      cwd: command.cwd,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const chunks: Buffer[] = [];
    let timedOut = false;
    let settled = false;
    const finish = (result: Omit<EditVerificationResult, 'durationMs'>) => {
      if (settled) return;
      settled = true;
      resolve({ ...result, durationMs: Math.max(0, Date.now() - started) });
    };
    child.stdout.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    child.stderr.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, command.timeoutMs ?? 60_000);
    const abort = () => child.kill();
    if (signal) signal.addEventListener('abort', abort, { once: true });
    child.once('error', (error) => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', abort);
      finish({ id: command.id, label: command.label, command: command.command, status: 'failed', summary: redactText(error.message).slice(0, 500), output: redactText(Buffer.concat(chunks).toString('utf8')).slice(-4000) });
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', abort);
      const output = redactText(Buffer.concat(chunks).toString('utf8')).slice(-4000);
      if (timedOut) finish({ id: command.id, label: command.label, command: command.command, status: 'timeout', summary: '验证超时', output });
      else if (signal?.aborted) finish({ id: command.id, label: command.label, command: command.command, status: 'skipped', summary: '验证被取消', output });
      else if (code === 0) finish({ id: command.id, label: command.label, command: command.command, status: 'passed', exitCode: code, summary: '验证通过', output });
      else finish({ id: command.id, label: command.label, command: command.command, status: 'failed', exitCode: code ?? undefined, summary: `验证失败（退出码 ${code ?? 'unknown'}）`, output });
    });
  });
}

// Windows 上 npm 需通过 npm.cmd 启动，其余平台直接使用 npm；shell 保持关闭，脚本名不作 shell 解析。
function npmScript(
  script: string,
  label: string,
  cwd: string,
  required: boolean,
  timeoutMs?: number,
): VerificationCommand {
  return {
    id: script,
    label,
    command: `npm run ${script}`,
    executable: process.platform === 'win32' ? 'npm.cmd' : 'npm',
    args: ['run', script],
    cwd,
    required,
    timeoutMs,
  };
}

async function packageScripts(root: string): Promise<Record<string, unknown>> {
  try {
    const parsed = JSON.parse(await readFile(`${root}/package.json`, 'utf8')) as { scripts?: unknown };
    return parsed.scripts && typeof parsed.scripts === 'object' ? parsed.scripts as Record<string, unknown> : {};
  } catch { return {}; }
}
