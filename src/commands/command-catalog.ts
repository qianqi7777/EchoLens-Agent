export type CommandCategory = 'workspace' | 'session' | 'task' | 'skill' | 'system';

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
  skillImportAvailable?: boolean;
  skillsAvailable?: boolean;
  modelRoutingAvailable?: boolean;
  hooksAvailable?: boolean;
  mcpAvailable?: boolean;
  pluginAvailable?: boolean;
  auditAvailable?: boolean;
  verificationAvailable?: boolean;
  rollbackAvailable?: boolean;
  goalAvailable?: boolean;
}

export const BUILTIN_COMMANDS: readonly CommandDescriptor[] = [
  {
    name: '/mcp',
    description: '查看已连接 MCP Server 及其配额用量',
    usage: '/mcp',
    category: 'system',
    acceptsArguments: false,
    availableDuringTask: true,
    source: 'builtin',
  },
  {
    name: '/plugin',
    description: '列出、导出或导入插件分发包',
    usage: '/plugin <list|export|import> [name|path]',
    category: 'system',
    acceptsArguments: true,
    availableDuringTask: false,
    source: 'builtin',
  },
  {
    name: '/audit',
    description: '校验或导出当前 Session 的审计哈希链',
    usage: '/audit verify | /audit export <path>',
    category: 'system',
    acceptsArguments: true,
    availableDuringTask: false,
    source: 'builtin',
  },
  {
    name: '/hooks',
    description: '查看、信任、撤销或重载生命周期 Hook',
    usage: '/hooks [trust|revoke|reload] [id|all]',
    category: 'system',
    acceptsArguments: true,
    availableDuringTask: false,
    source: 'builtin',
  },
  {
    name: '/model',
    description: '查看或设置当前 Session 的模型路由模式',
    usage: '/model [auto|fast|balanced|quality|privacy|off|pinned:<profile-id>]（阶段切换请用 /plan）',
    category: 'session',
    acceptsArguments: true,
    availableDuringTask: false,
    source: 'builtin',
  },
  {
    name: '/plan',
    description: '查看或切换执行阶段（规划为只读模式）',
    usage: '/plan [on|off|plan|execute|verify|status]',
    category: 'session',
    acceptsArguments: true,
    availableDuringTask: true,
    source: 'builtin',
  },
  {
    name: '/goal',
    description: '设置、查看或结束当前目标',
    usage: '/goal [status|done|drop|note <证据>] | <目标描述>',
    category: 'session',
    acceptsArguments: true,
    availableDuringTask: true,
    source: 'builtin',
  },
  {
    name: '/skill',
    description: '加载指定 Skill 或导入本地 Skill 包',
    usage: '/skill <name> | /skill import <path>',
    category: 'skill',
    acceptsArguments: true,
    availableDuringTask: false,
    source: 'builtin',
  },
  {
    name: '/skills',
    description: '列出当前可用的 Agent Skills',
    category: 'skill',
    acceptsArguments: false,
    availableDuringTask: false,
    source: 'builtin',
  },
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
    name: '/pause',
    description: '在当前工具批次完成后安全暂停 Turn',
    usage: '/pause',
    category: 'session',
    acceptsArguments: false,
    availableDuringTask: true,
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
    name: '/usage',
    description: '汇总后台任务的 token、步骤、工具调用和估算成本',
    usage: '/usage [session-id]',
    category: 'task',
    acceptsArguments: true,
    availableDuringTask: false,
    source: 'builtin',
  },
  {
    name: '/task',
    description: '创建、取消或恢复后台任务，或调整 Worker 并发',
    usage: '/task <explore|test|review|cancel|resume|concurrency>',
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
    usage: '/rollback <checkpoint-id> [文件路径...] | /rollback --to <检查点索引>',
    category: 'workspace',
    acceptsArguments: true,
    availableDuringTask: false,
    source: 'builtin',
  },
  {
    name: '/rewind',
    description: '选择会话检查点并分别回退代码或会话状态',
    usage: '/rewind [检查点索引] [--code|--conversation]',
    category: 'workspace',
    acceptsArguments: true,
    availableDuringTask: false,
    source: 'builtin',
  },
  {
    name: '/diff',
    description: '查看当前或指定 Turn 基于检查点重建的任务变更包',
    usage: '/diff [turn-id]',
    category: 'workspace',
    acceptsArguments: true,
    availableDuringTask: false,
    source: 'builtin',
  },
  {
    name: '/context',
    description: '查看最近一次模型请求的上下文来源、占用和预算比例',
    usage: '/context',
    category: 'session',
    acceptsArguments: false,
    availableDuringTask: true,
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
    if (command.name === '/skill' && !context.skillImportAvailable) return false;
    if (command.name === '/skills' && !context.skillsAvailable) return false;
    if (command.name === '/model' && context.modelRoutingAvailable === false) return false;
    if (command.name === '/plan' && context.modelRoutingAvailable === false) return false;
    if (command.name === '/goal' && context.goalAvailable === false) return false;
    if (command.name === '/hooks' && context.hooksAvailable === false) return false;
    if (command.name === '/mcp' && !context.mcpAvailable) return false;
    if (command.name === '/plugin' && !context.pluginAvailable) return false;
    if (command.name === '/audit' && !context.auditAvailable) return false;
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
