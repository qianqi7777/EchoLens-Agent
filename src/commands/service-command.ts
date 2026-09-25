import { executeSessionCommand, type SessionCommands } from './session-command.js';
import { executeBackgroundTaskCommand, type BackgroundTaskCommands } from '../orchestration/task-command.js';
import { executeWorkspaceCommand, type WorkspaceCommandService, type WorkspaceCommandResult } from '../runtime/workspace-manager.js';
import type { EditCheckpoint, RollbackToResult } from '../runtime/structured-patch.js';
import type { EditVerificationResult } from '../runtime/verification.js';
import type { ImportedSkill } from '../skills/skill-manager.js';
import type { LoadedSkill, SkillCatalogEntry } from '../skills/loader.js';
import type { SkillActivation } from '../skills/skill-runtime.js';
import type { HookStatus } from '../orchestration/command-hooks.js';
import type { AgentGoal } from '../runtime/goal.js';
import type { AgentPlan } from '../runtime/structured-output.js';
import type { ChangeSet } from '../runtime/change-set.js';
import type { RewindMode, RewindResult, SessionCheckpointSummary } from '../session/session-runtime.js';

export interface HookCommands {
  list(): HookStatus[];
  trust(selector: string): Promise<string[]>;
  revoke(selector: string): Promise<string[]>;
  reload(): Promise<string[]>;
}

/** 两种终端共用业务命令，确认、进度和显示状态由界面提供。 */
export interface CommandServices {
  listSessions: SessionCommands['list'];
  deleteSession?: SessionCommands['delete'];
  verify(): Promise<readonly EditVerificationResult[]>;
  rollback(checkpoint: EditCheckpoint): Promise<{ restoredPaths: string[]; skippedPaths: string[] }>;
  restoreFiles?(checkpoint: EditCheckpoint, paths: readonly string[]): Promise<{ restoredPaths: string[]; skippedPaths: string[] }>;
  rollbackTo?(index: number): Promise<RollbackToResult>;
  listCheckpoints?(): Promise<readonly string[]>;
  listRewindCheckpoints?(): Promise<readonly SessionCheckpointSummary[]>;
  rewind?(targetIndex: number, mode: RewindMode): Promise<RewindResult>;
  pause?(): Promise<void>;
  loadCheckpoint(id: string): Promise<EditCheckpoint>;
  diff?(turnId?: string): Promise<ChangeSet | undefined>;
  backgroundTasks?: BackgroundTaskCommands;
  workspaceCommands?: WorkspaceCommandService;
  importSkill?(source: string): Promise<ImportedSkill>;
  listSkills?(): Promise<SkillCatalogEntry[]>;
  loadSkill?(name: string): Promise<LoadedSkill>;
  activateSkill?(name: string): Promise<SkillActivation>;
  modelRouting?: {
    configure(mode?: string, phase?: string): Promise<string[]>;
    status(): string[];
  };
  hooks?: HookCommands;
  plans?: {
    decide(planId: string, decision: 'approved' | 'edited' | 'rejected', plan?: AgentPlan): Promise<void>;
    approveAsGoal(planId: string, plan: AgentPlan, edited?: boolean): Promise<AgentGoal>;
  };
  goals?: {
    status(): AgentGoal | undefined;
    set(statement: string, criteria?: readonly string[]): Promise<AgentGoal>;
    note(text: string): Promise<void>;
    close(status: 'met' | 'dropped'): Promise<void>;
  };
}

const serviceCommands = new Set(['/pwd', '/cd', '/workspace', '/tasks', '/usage', '/task', '/sessions', '/session', '/verify', '/rollback', '/rewind', '/diff', '/pause', '/skill', '/skills', '/model', '/plan', '/goal', '/hooks']);

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
    case '/tasks': case '/usage': case '/task':
      if (!services.backgroundTasks) throw new Error('后台任务服务不可用。');
      return executeBackgroundTaskCommand(input, services.backgroundTasks);
    case '/diff': {
      if (!services.diff) throw new Error('变更包服务不可用。');
      if (args.length > 1) return { handled: true, lines: ['用法：/diff [turn-id]'] };
      const changeSet = await services.diff(args[0]);
      if (!changeSet) return { handled: true, lines: ['当前没有可用的任务变更包。'] };
      lines = [
        `变更包：${changeSet.files.length} 个文件，${changeSet.checkpointIds.length} 个 checkpoint${changeSet.truncated ? '（已截断）' : ''}`,
        ...changeSet.files.map((file) => `${file.path} (${file.beforeExisted ? '修改' : '新增'} -> ${file.afterExisted ? '存在' : '删除'})`),
        changeSet.diff || '[info] 没有可见差异',
      ];
      return { handled: true, lines, changeSet };
    }
    case '/pause':
      if (args.length > 0) return { handled: true, lines: ['用法：/pause'] };
      if (!services.pause) throw new Error('暂停服务不可用。');
      await services.pause();
      lines = ['已请求暂停，将在当前工具批次完成后暂停。'];
      break;
    case '/skills': {
      if (args.length > 0) return { handled: true, lines: ['用法：/skills'] };
      if (!services.listSkills) throw new Error('Skill 列表服务不可用');
      const skills = await services.listSkills();
      lines = skills.length ? skills.map((skill) => `${skill.name} [${skill.source}]：${skill.description}`) : ['当前没有可用 Skill'];
      break;
    }
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
      if (args[0] === '--to') {
        if (!services.rollbackTo || args.length !== 2 || !/^\d+$/u.test(args[1] ?? '')) {
          return { handled: true, lines: ['用法：/rollback --to <检查点索引>'] };
        }
        const result = await services.rollbackTo(Number(args[1]));
        lines = [`已回退到 checkpoint[${result.targetIndex}]，处理 ${result.completedCheckpointIds.length} 个检查点，恢复 ${result.restoredPaths.length} 个文件`,
          ...result.skippedPaths.map((file) => `警告：跳过后续修改：${file}`)];
        break;
      }
      if (!args[0] || (args.length > 1 && !services.restoreFiles)) {
        return { handled: true, lines: ['用法：/rollback <checkpoint-id> [文件路径...] 或 /rollback --to <检查点索引>'] };
      }
      const checkpoint = await services.loadCheckpoint(args[0]);
      const result = args.length > 1
        ? await services.restoreFiles!(checkpoint, args.slice(1))
        : await services.rollback(checkpoint);
      lines = [`已回滚 checkpoint=${args[0]}，恢复 ${result.restoredPaths.length} 个文件`,
        ...result.skippedPaths.map((file) => `警告：跳过后续修改：${file}`)];
      break;
    }
    case '/rewind': {
      if (!services.rewind || !services.listRewindCheckpoints) throw new Error('rewind 服务不可用');
      if (args.length === 0) {
        const checkpoints = await services.listRewindCheckpoints();
        lines = checkpoints.length === 0
          ? ['当前没有可回退的会话检查点。']
          : ['最近会话检查点（使用 /rewind <索引> [--code|--conversation]）：',
            ...checkpoints.map((item) => `checkpoint[${item.index}] turn=${item.turnId} step=${item.step} phase=${item.phase} state=${item.state} time=${item.timestamp}`)];
        break;
      }
      const modeArgs = args.filter((arg): arg is '--code' | '--conversation' => arg === '--code' || arg === '--conversation');
      if (modeArgs.length > 1 || args.some((arg) => arg.startsWith('--') && !['--code', '--conversation'].includes(arg))) {
        return { handled: true, lines: ['用法：/rewind [检查点索引] [--code|--conversation]'] };
      }
      const indexArg = args.find((arg) => !arg.startsWith('--'));
      if (!indexArg || !/^\d+$/u.test(indexArg) || args.filter((arg) => !arg.startsWith('--')).length !== 1) {
        return { handled: true, lines: ['用法：/rewind [检查点索引] [--code|--conversation]'] };
      }
      const mode: RewindMode = modeArgs[0] === '--code' ? 'code'
        : modeArgs[0] === '--conversation' ? 'conversation' : 'both';
      const result = await services.rewind(Number(indexArg), mode);
      lines = [`已 rewind checkpoint[${result.targetIndex}]（${mode}），恢复会话 step=${result.checkpoint.step}`,
        `代码恢复 ${result.restoredPaths.length} 个文件`,
        ...result.skippedPaths.map((file) => `警告：跳过用户后续修改：${file}`)];
      break;
    }
    case '/skill': {
      const match = /^\/skill\s+import\s+(.+)$/u.exec(input);
      if (match) {
        if (!services.importSkill) throw new Error('Skill 导入服务不可用');
        const raw = match[1]!.trim();
        const source = /^(".*"|'.*')$/u.test(raw) ? raw.slice(1, -1) : raw;
        const result = await services.importSkill(source);
        lines = [`已导入 Skill：${result.name} -> ${result.destinationPath}`];
        break;
      }
      const name = args[0];
      if (!name || args.length !== 1 || (!services.loadSkill && !services.activateSkill)) return { handled: true, lines: ['用法：/skill <name> 或 /skill import <path>'] };
      if (services.activateSkill) {
        const activation = await services.activateSkill(name);
        lines = activation.skills.flatMap((skill) => [`Skill：${skill.name}`, skill.description, skill.body]);
      } else {
        const result = await services.loadSkill!(name);
        lines = [`Skill：${result.name}`, result.description, result.body];
      }
      break;
    }
    case '/model': {
      if (!services.modelRouting) throw new Error('模型路由服务不可用');
      if (args.length > 2) return { handled: true, lines: ['用法：/model [模式] [auto|plan|execute|verify]'] };
      lines = args.length === 0 ? services.modelRouting.status() : await services.modelRouting.configure(args[0], args[1]);
      break;
    }
    case '/plan': {
      if (!services.modelRouting) throw new Error('模型路由服务不可用');
      if (args.length > 1) return { handled: true, lines: ['用法：/plan [on|off|plan|execute|verify|status]'] };
      const value = args[0];
      if (!value || value === 'status') {
        lines = services.modelRouting.status();
      } else {
        const phase = value === 'on' ? 'plan' : value === 'off' ? 'auto' : value;
        lines = await services.modelRouting.configure(undefined, phase);
      }
      break;
    }
    case '/goal': {
      if (!services.goals) throw new Error('目标服务不可用');
      const argument = input.slice('/goal'.length).trim();
      if (!argument || argument === 'status') {
        lines = formatGoalStatus(services.goals.status());
      } else if (argument === 'done' || argument === 'drop') {
        await services.goals.close(argument === 'done' ? 'met' : 'dropped');
        lines = [argument === 'done' ? '目标已完成' : '目标已放弃'];
      } else if (argument === 'note' || argument.startsWith('note ')) {
        const note = argument.slice('note'.length).trim();
        if (!note) return { handled: true, lines: ['用法：/goal note <证据>'] };
        await services.goals.note(note);
        lines = ['目标证据已记录'];
      } else {
        const goal = await services.goals.set(argument);
        lines = [`目标已设置：${goal.statement}`];
      }
      break;
    }
    case '/hooks': {
      if (!services.hooks) throw new Error('Hook 管理服务不可用');
      if (args.length === 0) {
        const statuses = services.hooks.list();
        lines = statuses.length === 0 ? ['未配置 Hook'] : statuses.map(formatHookStatus);
        break;
      }
      if (args[0] === 'reload' && args.length === 1) {
        lines = await services.hooks.reload();
        break;
      }
      if ((args[0] === 'trust' || args[0] === 'revoke') && args.length === 2 && args[1]) {
        if (args[0] === 'trust') {
          const targets = services.hooks.list().filter((item) => item.scope === 'project'
            && (args[1] === 'all' || item.id === args[1]));
          if (targets.length === 0) throw new Error(`未找到项目 Hook：${args[1]}`);
          const approved = await session.confirm([
            '项目 Hook 将在宿主机以当前用户权限执行外部程序。',
            ...targets.map((item) => `${item.runtimeId}: ${item.executable} fingerprint=${item.fingerprint?.slice(7, 19) ?? 'unknown'}`),
            '确认信任以上 Hook？',
          ].join('\n'));
          lines = approved ? await services.hooks.trust(args[1]) : ['已取消 Hook 信任操作'];
        } else {
          lines = await services.hooks.revoke(args[1]);
        }
        break;
      }
      lines = ['用法：/hooks [trust|revoke|reload] [id|all]'];
      break;
    }
    default: return { handled: false, lines: [] };
  }
  return { handled: true, lines };
}

function formatGoalStatus(goal: AgentGoal | undefined): string[] {
  if (!goal) return ['当前没有活动目标'];
  return [
    `目标：${goal.statement}`,
    `状态：${goal.status}，证据 ${goal.evidence.length} 条`,
    ...goal.criteria.map((item, index) => `${index + 1}. ${item}`),
    ...goal.evidence.slice(-5).map((item) => `[${item.kind}] ${item.summary}`),
  ];
}

function formatHookStatus(item: HookStatus): string {
  const state = !item.enabled ? 'disabled' : item.trusted ? 'trusted' : 'untrusted';
  return `${item.runtimeId} event=${item.event} state=${state} command=${item.executable}`;
}
