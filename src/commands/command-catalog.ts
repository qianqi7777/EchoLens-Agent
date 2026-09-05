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
}

export interface CommandCatalogContext {
  workspaceAvailable: boolean;
  backgroundTasksAvailable: boolean;
  busy?: boolean;
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
    availableDuringTask: false,
    source: 'builtin',
  },
  {
    name: '/clear',
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
    if (!context.workspaceAvailable && command.category === 'workspace') return false;
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
  const selectedName = command.aliases?.find((alias) => token !== undefined && alias.startsWith(token)) ?? command.name;
  return `${leading}${selectedName}${command.acceptsArguments ? ' ' : ''}`;
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
