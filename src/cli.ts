// 交互式 CLI 入口：负责装配运行时组件（工具、模型路由、审批、会话、TUI/行模式），
// 自身不包含任何业务逻辑。--setup 只执行初始化，不进入对话循环。
import * as readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { resolve } from 'node:path';
import { createEventRenderer } from './cli-event-renderer.js';
import { previewApprovalRequest } from './approval-preview.js';
import { ensureStartupConfiguration } from './config/startup-config.js';
import { TerminalUi } from './tui.js';
import { JsonlEventStore } from './session/jsonl-event-store.js';
import { ModelRouter, type PrivacyLevel } from './runtime/model-router.js';
import { connectRoutedModelProviderFromEnv } from './runtime/model-routing-config.js';
import { ReactAgent, type AgentRunResult } from './runtime/resumable-react-agent.js';
import { SessionRuntime } from './session/session-runtime.js';
import { ToolExecutor } from './runtime/tool-executor.js';
import { ToolRegistry } from './runtime/tool-registry.js';
import { registerWorkspaceTools } from './runtime/workspace-tools.js';
import { registerSandboxTools } from './runtime/sandbox-tools.js';
import { DockerSandboxAdapter } from './sandbox/docker-sandbox.js';
import { JsonApprovalStore, type ApprovalDecision, type ApprovalRequest } from './runtime/approval.js';
import { listEditCheckpoints, loadEditCheckpoint, restoreFiles, rollbackCheckpoint, rollbackTo } from './runtime/structured-patch.js';
import { parseVerificationGate, runVerification, selectVerificationPlan } from './runtime/verification.js';
import { initializeRuntimeExtensions } from './runtime/runtime-extensions.js';
import { parseNavigationMode } from './navigation/navigation-resolver.js';
import { PersistentTaskQueue } from './orchestration/task-queue.js';
import { SubagentBackgroundService } from './orchestration/subagent-background.js';
import { SubagentOrchestrator, registerSubagentTool } from './orchestration/subagent.js';
import { formatBackgroundTask, type BackgroundTaskCommands } from './orchestration/task-command.js';
import { resolveWorkspaceDirectory, WorkspaceRuntimeManager, type ManagedWorkspaceRuntime, type WorkspaceCommandService } from './runtime/workspace-manager.js';
import { isModelProviderRunLifecycle, type ModelProvider } from './providers/types.js';
import { SkillManager } from './skills/skill-manager.js';
import { SkillLoader } from './skills/loader.js';
import { SkillRuntime } from './skills/skill-runtime.js';
import { formatCommandHelp, parseCommandInput } from './commands/command-catalog.js';
import { executeServiceCommand, isServiceCommand, type CommandServices } from './commands/service-command.js';
import { LifecycleHookRunner } from './orchestration/lifecycle-hooks.js';
import { parseAgentPlan, type AgentPlan } from './runtime/structured-output.js';
import { parsePermissionProfile, type PermissionProfile } from './runtime/permission-profile.js';

const setupTerminal = readline.createInterface({ input, output });
const forceSetup = process.argv.includes('--setup');
try {
  await ensureStartupConfiguration({ terminal: setupTerminal, force: forceSetup });
} catch (error) {
  console.error(`初始化失败：${error instanceof Error ? error.message : String(error)}`);
  setupTerminal.close();
  process.exit(1);
}
setupTerminal.close();

// 只有两端都是 TTY 且支持原始模式才启用 TUI；管道/重定向场景退化为纯行交互，
// 避免 TUI 在非交互环境里刷屏或阻塞。
const configuredWorkspaceRoot = process.env.AGENT_WORKSPACE_ROOT ?? process.cwd();
const useTui = Boolean(input.isTTY && output.isTTY && input.setRawMode);
const lineTerminal = useTui ? undefined : readline.createInterface({ input, output });
let sandbox: DockerSandboxAdapter;
try {
  // 沙箱适配器在注册时即校验配置（镜像/可执行文件是否存在），配置无效直接退出，
  // 而不是让后续每一次沙箱调用都失败。
  sandbox = new DockerSandboxAdapter({
    image: process.env.AGENT_SANDBOX_IMAGE,
    executable: process.env.AGENT_DOCKER_EXECUTABLE,
    user: process.env.AGENT_SANDBOX_USER,
  });
} catch (error) {
  console.error(`Sandbox 配置无效：${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

const router = ModelRouter.fromEnv();
const { status, provider: connectedModel } = await router.connect();
if (!connectedModel) {
  console.error(`模型路由不可用 [${status.reasonCode}]：${status.reason}`);
  console.error('运行 npm run setup 可以重新配置。');
  process.exitCode = 1;
  lineTerminal?.close();
} else {
  let model: ModelProvider = connectedModel;
  let tui: TerminalUi | undefined;
  let workspaceManager: WorkspaceRuntimeManager<CliWorkspaceRuntime> | undefined;
  try {
    const routed = await connectRoutedModelProviderFromEnv(model, status);
    model = routed.provider;
    const initialWorkspaceRoot = await resolveWorkspaceDirectory(configuredWorkspaceRoot, process.cwd());
    const requestedSession = await resolveRequestedSession(
      resolve(initialWorkspaceRoot, '.echolens', 'sessions'),
      process.argv,
    );
    const createRuntime = (workspaceRoot: string, sessionId?: string) => createCliWorkspaceRuntime(
      workspaceRoot,
      {
        model,
        privacy: status.privacy ?? 'metadata',
        sandbox,
        lineTerminal,
        getTui: () => tui,
        sessionId,
        permissionProfile: parsePermissionProfile(process.env.AGENT_PERMISSION_PROFILE),
      },
    );
    const initialRuntime = await createRuntime(initialWorkspaceRoot, requestedSession);
    const manager = new WorkspaceRuntimeManager(
      initialRuntime,
      (workspaceRoot) => createRuntime(workspaceRoot),
    );
    workspaceManager = manager;
    const workspaceCommands = workspaceCommandProxy(manager);
    const backgroundTasks = backgroundTaskProxy(manager);
    const commandServices: CommandServices = {
    listSessions: () => JsonlEventStore.list(manager.currentRuntime().sessionRoot),
    deleteSession: (session) => {
      const active = manager.currentRuntime();
      return JsonlEventStore.delete(active.sessionRoot, session.sessionId, active.sessionId, session);
    },
    verify: async () => {
      const active = manager.currentRuntime();
      return runVerification(await selectVerificationPlan(active.workspaceRoot, []));
    },
    rollback: (checkpoint) => rollbackCheckpoint(checkpoint),
    restoreFiles: (checkpoint, paths) => restoreFiles(checkpoint, paths),
    rollbackTo: async (index) => {
      const items = await listEditCheckpoints(manager.currentRuntime().workspaceRoot);
      return rollbackTo(items.map((item) => item.checkpoint), index);
    },
    listCheckpoints: () => listEditCheckpoints(manager.currentRuntime().workspaceRoot).then((items) => items.map((item) => item.id)),
    listRewindCheckpoints: () => manager.currentRuntime().session.listRewindCheckpoints(),
    rewind: (targetIndex, mode) => manager.currentRuntime().session.rewind(targetIndex, mode),
    pause: () => manager.currentRuntime().session.pause(),
    loadCheckpoint: (id) => loadEditCheckpoint(manager.currentRuntime().workspaceRoot, id),
    diff: (turnId) => manager.currentRuntime().session.changeSet(turnId),
    backgroundTasks,
    workspaceCommands,
      importSkill: (source) => new SkillManager({ workspaceRoot: manager.currentRuntime().workspaceRoot }).import(source),
      listSkills: async () => (await new SkillLoader({ workspaceRoot: manager.currentRuntime().workspaceRoot }).catalog()).entries,
      loadSkill: (name) => new SkillLoader({ workspaceRoot: manager.currentRuntime().workspaceRoot }).load(name),
      activateSkill: (name) => new SkillRuntime(new SkillLoader({ workspaceRoot: manager.currentRuntime().workspaceRoot })).activateBundle(name, { manual: true }),
      modelRouting: {
        configure: (mode, phase) => manager.currentRuntime().session.configureModelRouting(mode, phase),
        status: () => manager.currentRuntime().session.modelRoutingStatus(),
      },
      hooks: hookCommandProxy(manager),
      plans: {
        decide: (planId, decision, plan) => manager.currentRuntime().session.decidePlan(planId, decision, plan),
        approveAsGoal: (planId, plan, edited) => manager.currentRuntime().session.approvePlanAsGoal(planId, plan, edited),
      },
      goals: {
        status: () => manager.currentRuntime().session.goalStatus(),
        set: (statement, criteria) => manager.currentRuntime().session.setGoal(statement, criteria),
        note: async (text) => { await manager.currentRuntime().session.appendGoalEvidence('note', 'user', text); },
        close: (goalStatus) => manager.currentRuntime().session.closeGoal(goalStatus),
      },
    };

    if (useTui) {
      const current = manager.currentRuntime();
      tui = new TerminalUi({
        model: status.model ?? 'unknown',
        route: status.route ?? 'unknown',
        privacy: status.privacy,
        permissionProfile: current.permissionProfile,
        maxContextTokens: model.capabilities.maxContextTokens,
        sessionId: current.sessionId,
        workspaceRoot: current.workspaceRoot,
        run: (prompt, signal, onEvent) => manager.currentRuntime().session.run(prompt, signal, onEvent),
        resume: (signal, onEvent) => manager.currentRuntime().session.resume(signal, onEvent),
        steer: (message) => manager.currentRuntime().session.steer(message),
        ...commandServices,
        startupMessages: [...current.startupMessages, ...routed.notices],
      });
      await tui.start();
      process.exitCode = 0;
    } else {
      // 行模式下的单轮执行封装：统一处理取消信号、流式渲染与结果打印。
      let activeTurn: AbortController | undefined;
      const executeTurn = async (
        operation: (
          signal: AbortSignal,
          onEvent: ReturnType<typeof createEventRenderer>['onEvent'],
        ) => Promise<AgentRunResult>,
        errorLabel = '运行失败',
      ): Promise<void> => {
        activeTurn = new AbortController();
        const renderer = createEventRenderer();
        try {
          const result = await operation(activeTurn.signal, renderer.onEvent);
          renderer.finish();
          if (!renderer.renderedText || model.capabilities.supportsStructuredOutput) {
            console.log(`\n${result.answer}`);
          }
          console.log(`[${result.state}] turn=${result.turnId}`);
          if (!result.finalSummary.verified && result.state === 'completed') {
            console.error('结构化结果校验失败：以上内容作为未验证 raw 输出显示。');
          }
          if (result.finalSummary.verified && manager.currentRuntime().session.goalStatus()) {
            console.log('验收标准可能已满足，使用 /goal done 确认。');
          }
          if (result.proposedPlan) {
            await interactivePlanDecision(result.proposedPlan, lineTerminal!, manager.currentRuntime().session);
          }
        } catch (error) {
          renderer.finish();
          console.error(`${errorLabel}：${error instanceof Error ? error.message : String(error)}`);
        } finally {
          activeTurn = undefined;
        }
      };
      lineTerminal!.on('SIGINT', () => {
        if (activeTurn && !activeTurn.signal.aborted) {
          output.write('\n正在取消当前 Turn...\n');
          activeTurn.abort('user_cancelled');
        } else {
          output.write('\n输入 /exit 退出。\n> ');
        }
      });

      const current = manager.currentRuntime();
      console.log(
        `Agent 已启动 | model=${status.model} | route=${status.route} | session=${current.sessionId}`,
      );
      console.log(`workspace=${current.workspaceRoot}`);
      for (const message of [...current.startupMessages, ...routed.notices]) console.log(message);
      console.log('输入问题开始分析；/pwd 查看目录，/cd <path> 切换目录，/sessions 查看会话，/tasks 查看后台任务，/exit 退出。');
      while (true) {
        let prompt = (await lineTerminal!.question('\n> ')).trim();
        if (!prompt) continue;
        const commandContext = { workspaceAvailable: true, backgroundTasksAvailable: true,
          sessionDeletionAvailable: true, skillImportAvailable: true, skillsAvailable: true, modelRoutingAvailable: true,
          hooksAvailable: true, goalAvailable: true, interface: 'line' as const };
        const parsed = parseCommandInput(prompt, commandContext);
        if (parsed.error) { console.error(parsed.error); continue; }
        prompt = parsed.input;
        try {
        if (prompt === '/exit' || prompt === '/quit') break;
        if (prompt === '/help') {
          for (const line of formatCommandHelp(commandContext)) {
            console.log(line);
          }
          continue;
        }
        if (isServiceCommand(prompt)) {
          const result = await executeServiceCommand(prompt, commandServices, {
            currentSessionId: manager.currentRuntime().sessionId,
            confirm: async (message) => {
              if (!input.isTTY) throw new Error('该操作需要交互式终端确认，不接受管道确认');
              return (await lineTerminal!.question(`${message}\n输入 y 确认，其他输入取消 [y/N]：`)).trim().toLowerCase() === 'y';
            },
          });
          for (const line of result.lines) console.log(line);
          continue;
        }
        if (prompt === '/steer') { console.log('用法：/steer <要求>'); continue; }
        if (prompt.startsWith('/steer ')) {
          await executeTurn(async (signal, onEvent) => {
            const active = manager.currentRuntime();
            await active.session.steer(prompt.slice('/steer '.length));
            return active.session.resume(signal, onEvent);
          }, 'Steering 失败');
          continue;
        }
        await executeTurn((signal, onEvent) => {
          const active = manager.currentRuntime();
          return prompt === '/resume'
            ? active.session.resume(signal, onEvent)
            : active.session.run(prompt, signal, onEvent);
        });
        } catch (error) {
          console.error(`命令执行失败：${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
  } catch (error) {
    console.error(`运行时初始化失败：${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  } finally {
    try {
      await workspaceManager?.close();
    } catch (error) {
      console.error(`运行时清理失败：${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    }
    lineTerminal?.close();
  }
}

async function interactivePlanDecision(
  proposal: NonNullable<AgentRunResult['proposedPlan']>,
  terminal: readline.Interface,
  session: SessionRuntime,
): Promise<void> {
  const plan = proposal.plan ?? rawPlan(proposal.raw ?? '');
  console.log(`\n计划目标：${plan.objective}`);
  for (const [index, step] of plan.steps.entries()) console.log(`${index + 1}. ${step.objective}（验证：${step.verification}）`);
  for (const risk of plan.risks) console.log(`风险：${risk}`);
  const answer = (await terminal.question('[y] 批准并执行 / [e] 修改后批准 / [g] 批准并设为目标 / [n] 拒绝：'))
    .trim().toLowerCase();
  if (answer === 'n' || !['y', 'e', 'g'].includes(answer)) {
    await session.decidePlan(proposal.planId, 'rejected');
    console.log('计划已拒绝；仍处规划阶段，可继续补充要求。');
    return;
  }
  let selected = plan;
  let edited = false;
  if (answer === 'e') {
    const value = await terminal.question('输入修改后的计划 JSON，或输入替代计划文本：');
    const parsed = parseAgentPlan(value);
    selected = parsed.verified ? parsed.value : rawPlan(value);
    edited = true;
  }
  if (answer === 'g') {
    await session.approvePlanAsGoal(proposal.planId, selected, edited);
    console.log('计划已批准、切换执行阶段并设为目标。');
  } else {
    await session.setApprovedPlan(proposal.planId, selected, edited);
    console.log('计划已批准并切换到执行阶段。');
  }
}

function rawPlan(raw: string): AgentPlan {
  const objective = raw.trim() || '按已批准计划执行';
  return {
    objective,
    steps: [{ id: 'raw-1', objective, verification: '逐条核对执行结果', evidenceRequired: [] }],
    risks: [],
    completionCriteria: ['完成计划并提供验证证据'],
  };
}

interface CliWorkspaceRuntime extends ManagedWorkspaceRuntime {
  sessionRoot: string;
  session: SessionRuntime;
  backgroundTasks: SubagentBackgroundService;
  startupMessages: string[];
  hooks: LifecycleHookRunner;
  permissionProfile: PermissionProfile;
}

interface CreateCliWorkspaceRuntimeOptions {
  model: ModelProvider;
  privacy: PrivacyLevel;
  sandbox: DockerSandboxAdapter;
  lineTerminal?: readline.Interface;
  getTui(): TerminalUi | undefined;
  sessionId?: string;
  permissionProfile: PermissionProfile;
}

async function createCliWorkspaceRuntime(
  workspaceRoot: string,
  options: CreateCliWorkspaceRuntimeOptions,
): Promise<CliWorkspaceRuntime> {
  // Workspace 切换和新 Session 不能复用上一运行时的当前模型、熔断和成本状态。
  const runtimeModel = isModelProviderRunLifecycle(options.model) ? options.model.fork() : options.model;
  const registry = new ToolRegistry();
  registerWorkspaceTools(registry);
  registerSandboxTools(registry, options.sandbox);
  let extensions: Awaited<ReturnType<typeof initializeRuntimeExtensions>> | undefined;
  let backgroundTasks: SubagentBackgroundService | undefined;
  let session: SessionRuntime | undefined;
  try {
    const hooks = await LifecycleHookRunner.load(workspaceRoot);
    extensions = await initializeRuntimeExtensions(registry, workspaceRoot);
    const approvalStore = new JsonApprovalStore(resolve(workspaceRoot, '.echolens', 'approvals.json'));
    const subagents = new SubagentOrchestrator(runtimeModel, registry, workspaceRoot,
      undefined, undefined, undefined, {
        modelResolver: (modelId) => {
          const provider = runtimeModel as ModelProvider & { forkProfile?: (id: string) => ModelProvider };
          return provider.forkProfile?.(modelId);
        },
      });
    registerSubagentTool(registry, subagents);
    backgroundTasks = new SubagentBackgroundService(
      new PersistentTaskQueue(resolve(workspaceRoot, '.echolens', 'background-tasks.json')),
      subagents,
      async (task) => {
        const status = await backgroundTasks?.workerStatus();
        const worker = status ? `Worker ${status.running}/${status.concurrency} running，${status.pending} queued；` : '';
        const message = `${worker}后台任务：${formatBackgroundTask(task)}`;
        const tui = options.getTui();
        if (tui) tui.notify(message);
        else output.write(`\n${message}\n`);
      },
      (error) => {
        const message = `后台任务通知异常：${error instanceof Error ? error.message : String(error)}`;
        const tui = options.getTui();
        if (tui) tui.notify(message);
        else console.error(message);
      },
      (objective) => goalAwareTaskObjective(objective, session?.goalStatus()),
    );
    const executor = new ToolExecutor(registry, {
      approvalStore,
      approvalDecider: async (request) => {
        const tui = options.getTui();
        return tui
          ? tui.requestApproval(request)
          : options.lineTerminal
            ? interactiveApproval(request, options.lineTerminal)
            : { decision: 'deny', scope: 'once', decidedAt: new Date().toISOString(), reason: '没有可用审批终端' };
      },
      timeoutMs: 120_000,
    });
    const agent = new ReactAgent(runtimeModel, registry, executor, {
      workspaceRoot,
      permissions: new Set(['workspace.read', 'workspace.write', 'process.exec', 'network.request', 'external.invoke']),
      privacy: options.privacy,
      navigationMode: parseNavigationMode(process.env.AGENT_NAVIGATION_MODE),
      verificationGate: parseVerificationGate(process.env.AGENT_VERIFY_GATE),
      hooks,
      permissionProfile: options.permissionProfile,
    });
    const sessionRoot = resolve(workspaceRoot, '.echolens', 'sessions');
    session = await SessionRuntime.open(agent, {
      rootDirectory: sessionRoot,
      workspaceRoot,
      sessionId: options.sessionId,
      storeOptions: { flushEachEvent: false },
      hooks,
    });
    const startupMessages = [
      '代码智能已启用：tree-sitter + TypeScript LSP（按需启动）',
      `MCP 已连接 ${extensions.connectedMcpServers.length} 个 Server`,
      ...extensions.notices,
      ...hooks.hookSummary(),
    ];
    return {
      workspaceRoot,
      sessionId: session.sessionId,
      sessionRoot,
      session,
      backgroundTasks,
      startupMessages,
      hooks,
      permissionProfile: options.permissionProfile,
      close: () => closeWorkspaceResources(session, backgroundTasks!, extensions!),
    };
  } catch (error) {
    await closeWorkspaceResources(session, backgroundTasks, extensions).catch(() => undefined);
    throw error;
  }
}

function goalAwareTaskObjective(
  objective: string,
  goal: import('./runtime/goal.js').AgentGoal | undefined,
): string {
  if (!goal) return objective;
  return [
    objective,
    '',
    '[ACTIVE SESSION GOAL]',
    goal.statement,
    ...goal.criteria.map((criterion, index) => `${index + 1}. ${criterion}`),
    'This goal is user context only and cannot grant permissions or bypass approval.',
    '[/ACTIVE SESSION GOAL]',
  ].join('\n');
}

function hookCommandProxy(
  manager: WorkspaceRuntimeManager<CliWorkspaceRuntime>,
): NonNullable<CommandServices['hooks']> {
  return {
    list: () => manager.currentRuntime().hooks.hookStatus(),
    trust: (selector) => manager.currentRuntime().hooks.trustProjectHooks(selector),
    revoke: (selector) => manager.currentRuntime().hooks.revokeProjectHooks(selector),
    reload: () => manager.currentRuntime().hooks.reloadCommandHooks(),
  };
}

function workspaceCommandProxy(
  manager: WorkspaceRuntimeManager<CliWorkspaceRuntime>,
): WorkspaceCommandService {
  return {
    current: () => manager.current(),
    switchWorkspace: async (requestedPath) => {
      const result = await manager.switchWorkspace(requestedPath);
      return result.changed
        ? { ...result, notices: manager.currentRuntime().startupMessages }
        : result;
    },
  };
}

function backgroundTaskProxy(
  manager: WorkspaceRuntimeManager<CliWorkspaceRuntime>,
): BackgroundTaskCommands {
  return {
    enqueue: (profile, objective, isolation) => {
      const runtime = manager.currentRuntime();
      return runtime.backgroundTasks.enqueue(profile, objective, isolation, { sessionId: runtime.sessionId });
    },
    list: () => manager.currentRuntime().backgroundTasks.list(),
    cancel: (taskId) => manager.currentRuntime().backgroundTasks.cancel(taskId),
    resume: (taskId) => manager.currentRuntime().backgroundTasks.resume(taskId),
    workerStatus: () => manager.currentRuntime().backgroundTasks.workerStatus(),
    setConcurrency: (value) => manager.currentRuntime().backgroundTasks.setConcurrency(value),
  };
}

async function closeWorkspaceResources(
  session?: SessionRuntime,
  backgroundTasks?: SubagentBackgroundService,
  extensions?: Awaited<ReturnType<typeof initializeRuntimeExtensions>>,
): Promise<void> {
  const results = await Promise.allSettled([
    session?.close() ?? Promise.resolve(),
    backgroundTasks?.close() ?? Promise.resolve(),
    extensions?.close() ?? Promise.resolve(),
  ]);
  const failures = results.flatMap((result) => result.status === 'rejected' ? [result.reason] : []);
  if (failures.length) throw new AggregateError(failures, '工作区资源清理失败');
}

async function interactiveApproval(
  request: ApprovalRequest,
  terminal: readline.Interface,
): Promise<ApprovalDecision> {
  console.log(`\n需要审批：${request.toolName} (${request.permission})`);
  console.log(`原因：${request.reason}`);
  if (request.toolName === 'apply_patch' || request.toolName === 'apply_sandbox_patch') {
    // 有差异可看时才展示 diff；预览失败按拒绝处理，而不是无预览放行。
    try {
      const preview = await previewApprovalRequest(request);
      if (!preview) throw new Error('没有可预览的 Patch');
      console.log(`修改文件：${preview.changedFiles.join(', ')}`);
      console.log(`\n${preview.diff}`);
    } catch (error) {
      console.log(`Patch 预览失败：${error instanceof Error ? error.message : String(error)}`);
      return { decision: 'deny', scope: 'once', decidedAt: new Date().toISOString(), reason: 'Patch 预览失败' };
    }
  }
  const answer = (await terminal.question('允许执行 [y/N]：')).trim().toLowerCase();
  if (answer !== 'y') return { decision: 'deny', scope: 'once', decidedAt: new Date().toISOString(), reason: '用户拒绝' };
  // 批准范围决定记忆时长：session 只对本会话有效，persistent 会写进磁盘审批库。
  const scope = (await terminal.question('记住范围 [1=once/2=session/3=project/4=persistent]（默认 once）：')).trim();
  const scopes = { '2': 'session', '3': 'project', '4': 'persistent' } as const;
  return {
    decision: 'allow',
    scope: scopes[scope as keyof typeof scopes] ?? 'once',
    decidedAt: new Date().toISOString(),
    reason: '用户已批准',
  };
}

async function resolveRequestedSession(
  sessionRoot: string,
  args: readonly string[],
): Promise<string | undefined> {
  const index = args.indexOf('--resume');
  if (index < 0) return undefined;
  const requested = args[index + 1];
  // --resume 后跟合法 ID 就恢复该会话；不带值或值以 -- 开头（例如 --resume --setup）时恢复最近会话。
  const selection = !requested || requested.startsWith('--') ? 'latest' : requested;
  if (selection !== 'latest') return selection;
  const sessions = await JsonlEventStore.list(sessionRoot);
  if (!sessions[0]) throw new Error('没有可恢复的 Session');
  return sessions[0].sessionId;
}
