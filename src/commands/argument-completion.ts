import { opendir } from 'node:fs/promises';
import { homedir } from 'node:os';
import * as path from 'node:path';

export interface ArgumentCandidate {
  name: string;
  description: string;
  replacement: string;
}

export interface ArgumentCompletionContext {
  workspaceRoot: string;
  currentSessionId: string;
  listSessions(): Promise<readonly { sessionId: string }[]>;
  listTasks?(): Promise<readonly { id: string; state: string }[]>;
}

export async function completeArguments(input: string, context: ArgumentCompletionContext): Promise<ArgumentCandidate[]> {
  const match = /^\s*(\/\S+)\s+([^\r\n]*)$/u.exec(input);
  if (!match) return [];
  const command = match[1]!.toLowerCase();
  const args = match[2]!;
  const values = (prefix: string, entries: readonly [string, string][], fragment: string): ArgumentCandidate[] => entries
    .filter(([name]) => name.toLowerCase().startsWith(fragment.toLowerCase()))
    .map(([name, description]) => ({ name, description, replacement: `${command} ${prefix}${name} ` }));
  if (command === '/cd' || command === '/workspace') return directoryCandidates(command, args, context.workspaceRoot);
  if (command === '/task') {
    if (!args.includes(' ')) return values('', [
      ['explore', '探索代码'], ['test', '运行测试任务'], ['review', '审查代码'],
      ['cancel', '取消后台任务'], ['resume', '恢复后台任务'],
    ], args);
    const task = /^(cancel|resume)\s+(\S*)$/u.exec(args);
    if (task && context.listTasks) return values(`${task[1]} `,
      (await context.listTasks()).map((item) => [item.id, item.state]), task[2]!);
  }
  if (command === '/session') {
    if (!args.includes(' ')) return values('', [['delete', '删除历史会话，执行前需确认']], args);
    const deletion = /^delete\s+(\S*)$/u.exec(args);
    if (deletion) return values('delete ', (await context.listSessions())
      .filter((item) => item.sessionId !== context.currentSessionId)
      .map((item) => [item.sessionId, '历史会话']), deletion[1]!);
  }
  if (command === '/rollback' && !/\s/u.test(args)) {
    return values('', (await directoryEntries(path.join(context.workspaceRoot, '.echolens', 'checkpoints')))
      .filter((entry) => entry.isFile() && /^[A-Za-z0-9._-]+\.json$/u.test(entry.name))
      .map((entry) => [entry.name.slice(0, -5), '编辑检查点']), args);
  }
  return [];
}

async function directoryCandidates(command: string, args: string, workspaceRoot: string): Promise<ArgumentCandidate[]> {
  const quote = args.startsWith('"') || args.startsWith("'") ? args[0]! : '';
  const raw = quote ? args.slice(1).replace(new RegExp(`${quote}$`, 'u'), '') : args;
  const expanded = raw === '~' || raw.startsWith('~/') || raw.startsWith('~\\')
    ? path.join(homedir(), raw.slice(2)) + (raw === '~' ? path.sep : '') : raw;
  const slash = Math.max(expanded.lastIndexOf('/'), process.platform === 'win32' ? expanded.lastIndexOf('\\') : -1);
  const base = expanded.slice(0, slash + 1);
  const fragment = expanded.slice(slash + 1);
  const entries = await directoryEntries(path.resolve(workspaceRoot, base || '.'));
  return entries.filter((entry) => entry.isDirectory() && !/[\u0000-\u001f\u007f"']/u.test(entry.name)
    && entry.name.toLowerCase().startsWith(fragment.toLowerCase()))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((entry) => {
      const value = `${base}${entry.name}${path.sep}`;
      return { name: value, description: '工作目录', replacement: `${command} "${value}"` };
    });
}

async function directoryEntries(directory: string) {
  const entries = [];
  try {
    const handle = await opendir(directory);
    for await (const entry of handle) {
      entries.push(entry);
      if (entries.length >= 2000) break;
    }
  } catch (error) {
    if (!['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
  }
  return entries;
}
