import { executeSessionCommand, type SessionCommands } from './session-command.js';
import { executeBackgroundTaskCommand, type BackgroundTaskCommands } from '../orchestration/task-command.js';
import { executeWorkspaceCommand, type WorkspaceCommandService, type WorkspaceCommandResult } from '../runtime/workspace-manager.js';
import type { EditCheckpoint } from '../runtime/structured-patch.js';
import type { EditVerificationResult } from '../runtime/verification.js';
import type { ImportedSkill } from '../skills/skill-manager.js';

/** 两种终端共用业务命令，确认、进度和显示状态由界面提供。 */
export interface CommandServices {
  listSessions: SessionCommands['list'];
  deleteSession?: SessionCommands['delete'];
  verify(): Promise<readonly EditVerificationResult[]>;
  rollback(checkpoint: EditCheckpoint): Promise<{ restoredPaths: string[]; skippedPaths: string[] }>;
  loadCheckpoint(id: string): Promise<EditCheckpoint>;
  backgroundTasks?: BackgroundTaskCommands;
  workspaceCommands?: WorkspaceCommandService;
  importSkill?(source: string): Promise<ImportedSkill>;
  modelRouting?: {
    configure(mode?: string, phase?: string): Promise<string[]>;
    status(): string[];
  };
}

const serviceCommands = new Set(['/pwd', '/cd', '/workspace', '/tasks', '/task', '/sessions', '/session', '/verify', '/rollback', '/skill', '/model']);

export function isServiceCommand(input: string): boolean {
  return serviceCommands.has(input.split(/\s+/u)[0] ?? '');
}

export async function executeServiceCommand(
  input: string,
  services: CommandServices,
  session: { currentSessionId: string; confirm: SessionCommands['confirm'] },
): Promise<WorkspaceCommandResult> {
  const [command, ...args] = input.split(/\s+/u);
  let lines: string[];
  switch (command) {
    case '/pwd': case '/cd': case '/workspace':
      if (!services.workspaceCommands) throw new Error('工作目录切换服务不可用。');
      return executeWorkspaceCommand(input, services.workspaceCommands);
    case '/tasks': case '/task':
      if (!services.backgroundTasks) throw new Error('后台任务服务不可用。');
      return executeBackgroundTaskCommand(input, services.backgroundTasks);
    case '/sessions': case '/session':
      lines = await executeSessionCommand(input, {
        ...session, list: services.listSessions,
        delete: async (item) => {
          if (!services.deleteSession) throw new Error('会话删除服务不可用');
          await services.deleteSession(item);
        },
      });
      break;
    case '/verify':
      lines = (await services.verify()).map((item) => `${item.id}: ${item.status} - ${item.summary}`);
      break;
    case '/rollback': {
      if (args.length !== 1 || !args[0]) return { handled: true, lines: ['用法：/rollback <checkpoint-id>'] };
      const result = await services.rollback(await services.loadCheckpoint(args[0]));
      lines = [`已回滚 checkpoint=${args[0]}，恢复 ${result.restoredPaths.length} 个文件`,
        ...result.skippedPaths.map((file) => `警告：跳过后续修改：${file}`)];
      break;
    }
    case '/skill': {
      const match = /^\/skill\s+import\s+(.+)$/u.exec(input);
      if (!match) return { handled: true, lines: ['用法：/skill import <path>'] };
      if (!services.importSkill) throw new Error('Skill 导入服务不可用');
      const raw = match[1]!.trim();
      const source = /^(".*"|'.*')$/u.test(raw) ? raw.slice(1, -1) : raw;
      const result = await services.importSkill(source);
      lines = [`已导入 Skill：${result.name} -> ${result.destinationPath}`];
      break;
    }
    case '/model': {
      if (!services.modelRouting) throw new Error('模型路由服务不可用');
      if (args.length > 2) return { handled: true, lines: ['用法：/model [模式] [auto|plan|execute|verify]'] };
      lines = args.length === 0 ? services.modelRouting.status() : await services.modelRouting.configure(args[0], args[1]);
      break;
    }
    default: return { handled: false, lines: [] };
  }
  return { handled: true, lines };
}
