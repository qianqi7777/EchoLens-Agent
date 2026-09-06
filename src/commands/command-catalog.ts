export type CommandCategory = 'workspace' | 'session' | 'task' | 'system';

export interface CommandDescriptor {
  name: string;
  aliases?: readonly string[];
  description: string;
  usage?: string;
  category: CommandCategory;
  acceptsArguments: boolean;
  availableDuringTask: boolean;
  source: 'builtin';
  interfaces?: readonly ('tui' | 'line')[];
}

export interface CommandCatalogContext {
  workspaceAvailable: boolean;
  backgroundTasksAvailable: boolean;
  busy?: boolean;
  interface?: 'tui' | 'line';
  sessionDeletionAvailable?: boolean;
  verificationAvailable?: boolean;
  rollbackAvailable?: boolean;
}

export const BUILTIN_COMMANDS: readonly CommandDescriptor[] = [
  {
    name: '/pwd',
    description: '显示当前工作目录和 Session ID',
    category: 'workspace',
    acceptsArguments: false,
    availableDuringTask: false,
    source: 'builtin',
  },
  {
    name: '/cd',
    aliases: ['/workspace'],
    description: '查看或切换工作目录',
    usage: '/cd <path>',
    category: 'workspace',
    acceptsArguments: true,
    availableDuringTask: false,
    source: 'builtin',
  },
  {
    name: '/resume',
    description: '恢复当前 Session 的未完成 Turn',
    category: 'session',
    acceptsArguments: false,
    availableDuringTask: false,
    source: 'builtin',
  },
  {
    name: '/sessions',
    description: '列出当前工作目录的历史 Session',
    category: 'session',
    acceptsArguments: false,
    availableDuringTask: false,
    source: 'builtin',
  },
  {
    name: '/session',
    description: '删除指定历史会话（需再次确认）',
    usage: '/session delete <session-id>',
    category: 'session',
    acceptsArguments: true,
    availableDuringTask: false,
    source: 'builtin',
  },
  {
    name: '/tasks',
    description: '列出当前工作目录的后台任务',
    category: 'task',
    acceptsArguments: false,
    availableDuringTask: false,
    source: 'builtin',
  },
  {
    name: '/task',
    description: '创建、取消或恢复后台任务',
    usage: '/task <explore|test|review|cancel|resume>',
    category: 'task',
    acceptsArguments: true,
    availableDuringTask: false,
    source: 'builtin',
  },
  {
    name: '/verify',
    description: '运行当前工作区的验证计划',
    category: 'workspace',
    acceptsArguments: false,
    availableDuringTask: false,
    source: 'builtin',
  },
  {
    name: '/rollback',
    description: '回滚到指定的编辑检查点',
    usage: '/rollback <checkpoint-id>',
    category: 'workspace',
    acceptsArguments: true,
    availableDuringTask: false,
    source: 'builtin',
  },
  {
    name: '/steer',
    description: '追加要求并从当前检查点继续运行',
    usage: '/steer <要求>',
    category: 'session',
    acceptsArguments: true,
    availableDuringTask: true,
    source: 'builtin',
  },
  {
    name: '/clear',
    interfaces: ['tui'],
    description: '清空当前 TUI 的显示记录',
    category: 'system',
    acceptsArguments: false,
    availableDuringTask: false,
    source: 'builtin',
  },
  {
    name: '/help',
    description: '显示命令列表和用法',
    category: 'system',
    acceptsArguments: false,
    availableDuringTask: false,
    source: 'builtin',
  },
  {
    name: '/exit',
    aliases: ['/quit'],
    description: '退出当前 Agent 进程',
    category: 'system',
    acceptsArguments: false,
    availableDuringTask: false,
    source: 'builtin',
  },
];

export function getCommandCatalog(context: CommandCatalogContext): CommandDescriptor[] {
  return BUILTIN_COMMANDS.filter((command) => {
    if (!context.workspaceAvailable && ['/pwd', '/cd'].includes(command.name)) return false;
    if (command.name === '/session' && !context.sessionDeletionAvailable) return false;
    if (command.name === '/verify' && context.verificationAvailable === false) return false;
    if (command.name === '/rollback' && context.rollbackAvailable === false) return false;
    if (command.interfaces && !command.interfaces.includes(context.interface ?? 'tui')) return false;
    if (!context.backgroundTasksAvailable && command.category === 'task') return false;
    if (context.busy && !command.availableDuringTask) return false;
    return true;
  });
}

export function commandToken(input: string): string | undefined {
  const normalized = input.trimStart();
  if (!normalized.startsWith('/')) return undefined;
  const firstSpace = normalized.search(/\s/u);
  if (firstSpace >= 0) return undefined;
  return normalized.toLowerCase();
}

export function filterCommandCandidates(
  input: string,
  context: CommandCatalogContext,
): CommandDescriptor[] {
  const query = commandToken(input);
  if (query === undefined) return [];
  const commands = getCommandCatalog(context);
  return commands
    .map((command, index) => ({ command, index, rank: commandRank(command, query) }))
    .filter((item): item is { command: CommandDescriptor; index: number; rank: number } => item.rank < 3)
    .sort((left, right) => left.rank - right.rank || left.index - right.index)
    .map((item) => item.command);
}

export function completeCommand(input: string, command: CommandDescriptor): string {
  const leading = input.match(/^\s*/u)?.[0] ?? '';
  const token = commandToken(input);
  const selectedName = token && !command.name.startsWith(token)
    ? command.aliases?.find((alias) => alias.startsWith(token)) ?? command.name
    : command.name;
  return `${leading}${selectedName}${command.acceptsArguments ? ' ' : ''}`;
}

/** Canonicalize only the command token; preserve argument case, spaces and quotes. */
export function parseCommandInput(input: string, context: CommandCatalogContext): {
  input: string;
  command?: CommandDescriptor;
  error?: string;
} {
  const normalized = input.trim();
  if (!normalized.startsWith('/')) return { input: normalized };
  const [token = ''] = normalized.split(/\s/u);
  const command = BUILTIN_COMMANDS.find((item) => item.name === token.toLowerCase()
    || item.aliases?.includes(token.toLowerCase()));
  if (!command) return { input: normalized, error: `未知命令：${token}。输入 /help 查看命令。` };
  if (!getCommandCatalog(context).includes(command)) {
    return { input: normalized, command, error: `当前状态不支持命令：${command.name}` };
  }
  const args = normalized.slice(token.length).trim();
  if (args && !command.acceptsArguments) {
    return { input: normalized, command, error: `用法：${command.usage ?? command.name}` };
  }
  // /workspace without arguments has historically displayed the current directory.
  const name = token.toLowerCase() === '/workspace' && !args ? '/pwd' : command.name;
  return { input: `${name}${args ? ` ${args}` : ''}`, command };
}

export function commandMenuWindow(total: number, selected: number, capacity: number): { start: number; end: number } {
  const count = Math.max(0, Math.min(total, capacity));
  const start = Math.max(0, Math.min(selected - count + 1, total - count));
  return { start, end: start + count };
}

export function formatCommandHelp(context: CommandCatalogContext): string[] {
  return getCommandCatalog({ ...context, busy: false }).map((command) => {
    const aliases = command.aliases?.length ? `（别名：${command.aliases.join('、')}）` : '';
    const usage = command.usage ?? command.name;
    return `${usage}：${command.description}${aliases}`;
  });
}

function commandRank(command: CommandDescriptor, query: string): number {
  if (command.name === query || command.aliases?.some((alias) => alias === query)) return 0;
  if (command.name.startsWith(query) || command.aliases?.some((alias) => alias.startsWith(query))) return 1;
  if (command.description.toLowerCase().includes(query.slice(1))) return 2;
  return 3;
}
