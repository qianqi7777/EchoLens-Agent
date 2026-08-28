import * as readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { resolve } from 'node:path';
import { createEventRenderer } from './cli-event-renderer.js';
import { previewApprovalRequest } from './approval-preview.js';
import { ensureStartupConfiguration } from './config/startup-config.js';
import { TerminalUi } from './tui.js';
import {
  JsonlEventStore,
  ModelRouter,
  ReactAgent,
  SessionRuntime,
  ToolExecutor,
  ToolRegistry,
  registerWorkspaceTools,
  registerSandboxTools,
  DockerSandboxAdapter,
  JsonApprovalStore,
  loadEditCheckpoint,
  rollbackCheckpoint,
  runVerification,
  selectVerificationPlan,
  type ApprovalDecision,
  type ApprovalRequest,
  type AgentRunResult,
  initializeRuntimeExtensions,
} from './runtime/index.js';

const terminal = readline.createInterface({ input, output });
const forceSetup = process.argv.includes('--setup');
try {
  await ensureStartupConfiguration({ terminal, force: forceSetup });
} catch (error) {
  console.error(`初始化失败：${error instanceof Error ? error.message : String(error)}`);
  terminal.close();
  process.exit(1);
}
terminal.close();

const workspaceRoot = process.env.AGENT_WORKSPACE_ROOT ?? process.cwd();
const registry = new ToolRegistry();
registerWorkspaceTools(registry);
try {
  registerSandboxTools(registry, new DockerSandboxAdapter({
    image: process.env.AGENT_SANDBOX_IMAGE,
    executable: process.env.AGENT_DOCKER_EXECUTABLE,
    user: process.env.AGENT_SANDBOX_USER,
  }));
} catch (error) {
  console.error(`Sandbox 配置无效：${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

const router = ModelRouter.fromEnv();
const { status, provider: model } = await router.connect();
if (!model) {
  console.error(`模型路由不可用 [${status.reasonCode}]：${status.reason}`);
  console.error('运行 npm run setup 可以重新配置。');
  process.exitCode = 1;
  terminal.close();
} else {
  const extensions = await initializeRuntimeExtensions(registry, workspaceRoot);
  const startupMessages = [
    `代码智能已启用：tree-sitter + TypeScript LSP（按需启动）`,
    `MCP 已连接 ${extensions.connectedMcpServers.length} 个 Server`,
    ...extensions.notices,
  ];
  try {
  const approvalStore = new JsonApprovalStore(resolve(workspaceRoot, '.echolens', 'approvals.json'));
  let tui: TerminalUi | undefined;
  const executor = new ToolExecutor(registry, {
    approvalStore,
    approvalDecider: async (request) => tui
      ? tui.requestApproval(request)
      : interactiveApproval(request),
    timeoutMs: 120_000,
  });
  const agent = new ReactAgent(model, registry, executor, {
    workspaceRoot,
    permissions: new Set(['workspace.read', 'workspace.write', 'process.exec', 'network.request', 'external.invoke']),
    privacy: status.privacy,
  });
  const sessionRoot = resolve(workspaceRoot, '.echolens', 'sessions');
  const requestedSession = await resolveRequestedSession(sessionRoot, process.argv);
  const session = await SessionRuntime.open(agent, {
    rootDirectory: sessionRoot,
    workspaceRoot,
    sessionId: requestedSession,
    storeOptions: { flushEachEvent: false },
  });
  const useTui = Boolean(input.isTTY && output.isTTY && input.setRawMode);
  if (useTui) {
    tui = new TerminalUi({
      model: status.model ?? 'unknown',
      route: status.route ?? 'unknown',
      privacy: status.privacy,
      sessionId: session.sessionId,
      workspaceRoot,
      run: (prompt, signal, onEvent) => session.run(prompt, signal, onEvent),
      resume: (signal, onEvent) => session.resume(signal, onEvent),
      steer: (message) => session.steer(message),
      listSessions: () => JsonlEventStore.list(sessionRoot),
      verify: async () => runVerification(await selectVerificationPlan(workspaceRoot, [])),
      rollback: (checkpoint) => rollbackCheckpoint(checkpoint),
      loadCheckpoint: (id) => loadEditCheckpoint(workspaceRoot, id),
      startupMessages,
    });
    try {
      await tui.start();
    } finally {
      await session.close();
    }
    process.exitCode = 0;
  } else {
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
    } catch (error) {
      renderer.finish();
      console.error(`${errorLabel}：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      activeTurn = undefined;
    }
  };
  terminal.on('SIGINT', () => {
    if (activeTurn && !activeTurn.signal.aborted) {
      output.write('\n正在取消当前 Turn...\n');
      activeTurn.abort('user_cancelled');
    } else {
      output.write('\n输入 /exit 退出。\n> ');
    }
  });

  console.log(
    `Agent 已启动 | model=${status.model} | route=${status.route} | session=${session.sessionId}`,
  );
  console.log(`workspace=${workspaceRoot}`);
  for (const message of startupMessages) console.log(message);
  console.log('输入问题开始分析；/sessions 查看会话，/resume 恢复，/verify 验证，/rollback <id> 回滚，/exit 退出。');
  try {
    while (true) {
      const prompt = (await terminal.question('\n> ')).trim();
      if (!prompt) continue;
      if (prompt === '/exit' || prompt === '/quit') break;
      if (prompt === '/sessions') {
        const sessions = await JsonlEventStore.list(sessionRoot);
        for (const item of sessions.slice(0, 20)) {
          console.log(`${item.sessionId} | ${item.modifiedAt} | ${item.bytes} bytes`);
        }
        if (sessions.length === 0) console.log('暂无 Session。');
        continue;
      }
      if (prompt === '/verify') {
        const plan = await selectVerificationPlan(workspaceRoot, []);
        const results = await runVerification(plan);
        for (const result of results) console.log(`${result.id}: ${result.status} - ${result.summary}`);
        continue;
      }
      if (prompt.startsWith('/rollback')) {
        const requested = prompt.split(/\s+/u)[1];
        if (!requested) { console.log('用法：/rollback <checkpoint-id>'); continue; }
        const rollback = await rollbackCheckpoint(await loadEditCheckpoint(workspaceRoot, requested));
        console.log(`已回滚 checkpoint=${requested}，恢复 ${rollback.restoredPaths.length} 个文件`);
        if (rollback.skippedPaths.length) console.log(`检测到后续用户修改，跳过：${rollback.skippedPaths.join(', ')}`);
        continue;
      }
      if (prompt.startsWith('/steer ')) {
        await executeTurn(async (signal, onEvent) => {
          await session.steer(prompt.slice('/steer '.length));
          return session.resume(signal, onEvent);
        }, 'Steering 失败');
        continue;
      }
      await executeTurn((signal, onEvent) => prompt === '/resume'
        ? session.resume(signal, onEvent)
        : session.run(prompt, signal, onEvent));
    }
  } finally {
    await session.close();
  }
  }
  } finally {
    await extensions.close();
  }
}

async function interactiveApproval(request: ApprovalRequest): Promise<ApprovalDecision> {
  console.log(`\n需要审批：${request.toolName} (${request.permission})`);
  console.log(`原因：${request.reason}`);
  if (request.toolName === 'apply_patch' || request.toolName === 'apply_sandbox_patch') {
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
  const selection = !requested || requested.startsWith('--') ? 'latest' : requested;
  if (selection !== 'latest') return selection;
  const sessions = await JsonlEventStore.list(sessionRoot);
  if (!sessions[0]) throw new Error('没有可恢复的 Session');
  return sessions[0].sessionId;
}
