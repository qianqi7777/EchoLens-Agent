import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { redactText } from '../providers/redaction.js';
import type { ToolContext } from './types.js';
import { ToolRegistry } from './tool-registry.js';
import { toolFailure, toolSuccess } from './tool-result.js';
import { objectSchema } from './tool-schema.js';

const execFileAsync = promisify(execFile);
const RELATIVE_PATH = '^(?![\\/])[^\\r\\n]{1,4096}$';
const FORBIDDEN = /^(?:--git-dir|--work-tree|--no-index|-c|--exec-path|--upload-pack|--receive-pack)(?:=|$)/u;

/** 只读 Git 工具。所有命令固定通过 execFile + argv，并绑定到 ToolContext.workspaceRoot。 */
export function registerGitTools(registry: ToolRegistry): void {
  registry.register({
    name: 'git_status', description: '读取工作区 Git 状态（不执行写操作）。', permission: 'workspace.read', effect: 'read',
    inputSchema: objectSchema({ porcelain: { type: 'boolean' }, branch: { type: 'boolean' } }),
    execute: async (args, context) => executeGit('status', () => statusArgs(args), context, 1_024 * 1_024),
  });
  registry.register({
    name: 'git_diff', description: '读取工作区未提交 Git diff（不执行写操作）。', permission: 'workspace.read', effect: 'read',
    inputSchema: objectSchema({ path: { type: 'string', pattern: RELATIVE_PATH }, cached: { type: 'boolean' }, stat: { type: 'boolean' }, numstat: { type: 'boolean' } }),
    execute: async (args, context) => executeGit('diff', () => diffArgs(args), context, 256 * 1024),
  });
  registry.register({
    name: 'git_log', description: '读取最近 Git 提交摘要（不执行写操作）。', permission: 'workspace.read', effect: 'read',
    inputSchema: objectSchema({ maxCount: { type: 'integer', minimum: 1, maximum: 100 }, path: { type: 'string', pattern: RELATIVE_PATH } }),
    execute: async (args, context) => executeGit('log', () => logArgs(args), context, 64 * 1024),
  });
}

function statusArgs(args: Record<string, unknown>): string[] {
  const output = ['-C'];
  // status 的选项只允许固定白名单，避免把模型参数当成 Git 配置或路径解释。
  if (args.porcelain !== false) output.push('--porcelain=v1');
  if (args.branch === true) output.push('--branch');
  return output;
}

function diffArgs(args: Record<string, unknown>): string[] {
  const output = ['-C'];
  if (args.cached === true) output.push('--cached');
  if (args.stat === true) output.push('--stat');
  if (args.numstat === true) output.push('--numstat');
  output.push('--no-ext-diff', '--');
  if (typeof args.path === 'string') output.push(validateRelativePath(args.path));
  return output;
}

function logArgs(args: Record<string, unknown>): string[] {
  const count = typeof args.maxCount === 'number' ? args.maxCount : 20;
  const output = ['-C', '--no-decorate', '--no-renames', `--max-count=${Math.trunc(count)}`, '--format=%H%x09%aI%x09%an%x09%s', '--'];
  if (typeof args.path === 'string') output.push(validateRelativePath(args.path));
  return output;
}

async function runGit(command: 'status' | 'diff' | 'log', args: string[], context: ToolContext, maxOutputBytes: number) {
  const workspaceRoot = context.workspaceRoot;
  // -C 必须由工具自身拼接，调用方只能提供经过 schema 与相对路径校验的叶子路径。
  const fullArgs = ['-C', workspaceRoot, command, ...args.slice(1)];
  if (fullArgs.some((arg) => FORBIDDEN.test(arg))) return toolFailure('denied', 'permission_denied', 'Git 参数包含被禁止的穿透性选项');
  try {
    const result = await execFileAsync('git', fullArgs, {
      cwd: workspaceRoot, shell: false, windowsHide: true, timeout: 15_000, maxBuffer: maxOutputBytes,
      signal: context.signal,
    });
    const content = redactText(String(result.stdout ?? '')).slice(0, maxOutputBytes);
    return toolSuccess(content || '[info] Git 没有输出', `git ${command} 完成`, [`git:${command}`], { command, truncated: Buffer.byteLength(String(result.stdout ?? ''), 'utf8') > maxOutputBytes });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Git 命令失败';
    return toolFailure('failed', 'command_failed', `git ${command} 失败：${redactText(message).slice(0, 500)}`);
  }
}

async function executeGit(command: 'status' | 'diff' | 'log', args: () => string[], context: ToolContext, maxOutputBytes: number) {
  try { return await runGit(command, args(), context, maxOutputBytes); }
  catch (error) { return toolFailure('invalid', 'invalid_arguments', error instanceof Error ? error.message : 'Git 参数无效'); }
}

function validateRelativePath(value: string): string {
  if (!value || value.startsWith('/') || value.startsWith('\\') || value.includes('..') || FORBIDDEN.test(value)) throw new Error('Git 路径必须是工作区内相对路径');
  return value;
}
