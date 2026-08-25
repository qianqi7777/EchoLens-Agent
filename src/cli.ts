import * as readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { resolve } from 'node:path';
import { ensureStartupConfiguration } from './config/startup-config.js';
import {
  JsonlEventStore,
  ModelRouter,
  ReactAgent,
  SessionRuntime,
  ToolExecutor,
  ToolRegistry,
  registerWorkspaceTools,
  type AgentEvent,
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

const workspaceRoot = process.env.AGENT_WORKSPACE_ROOT ?? process.cwd();
const registry = new ToolRegistry();
registerWorkspaceTools(registry);

const router = ModelRouter.fromEnv();
const { status, provider: model } = await router.connect();
if (!model) {
  console.error(`模型路由不可用 [${status.reasonCode}]：${status.reason}`);
  console.error('运行 npm run setup 可以重新配置。');
  process.exitCode = 1;
  terminal.close();
} else {
  const agent = new ReactAgent(model, registry, new ToolExecutor(registry), {
    workspaceRoot,
    permissions: new Set(['workspace.read']),
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
  let activeTurn: AbortController | undefined;
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
  console.log('输入问题开始分析；/sessions 查看会话，/resume 恢复，/exit 退出。');
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
      if (prompt.startsWith('/steer ')) {
        try {
          await session.steer(prompt.slice('/steer '.length));
          activeTurn = new AbortController();
          const renderer = createEventRenderer();
          const result = await session.resume(activeTurn.signal, renderer.onEvent);
          renderer.finish();
          if (!renderer.renderedText || model.capabilities.supportsStructuredOutput) {
            console.log(`\n${result.answer}`);
          }
          console.log(`[${result.state}] turn=${result.turnId}`);
        } catch (error) {
          console.error(`Steering 失败：${error instanceof Error ? error.message : String(error)}`);
        } finally {
          activeTurn = undefined;
        }
        continue;
      }
      try {
        activeTurn = new AbortController();
        const renderer = createEventRenderer();
        const result = prompt === '/resume'
          ? await session.resume(activeTurn.signal, renderer.onEvent)
          : await session.run(prompt, activeTurn.signal, renderer.onEvent);
        renderer.finish();
        if (!renderer.renderedText || model.capabilities.supportsStructuredOutput) {
          console.log(`\n${result.answer}`);
        }
        console.log(`[${result.state}] turn=${result.turnId}`);
        if (!result.finalSummary.verified && result.state === 'completed') {
          console.error('结构化结果校验失败：以上内容作为未验证 raw 输出显示。');
        }
      } catch (error) {
        console.error(`运行失败：${error instanceof Error ? error.message : String(error)}`);
      } finally {
        activeTurn = undefined;
      }
    }
  } finally {
    await session.close();
    terminal.close();
  }
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

function createEventRenderer(): {
  renderedText: boolean;
  onEvent: (event: AgentEvent) => void;
  finish: () => void;
} {
  const state = { renderedText: false, lineOpen: false };
  return {
    get renderedText() { return state.renderedText; },
    onEvent(event) {
      if (event.payload.type === 'model.output.delta') {
        output.write(event.payload.delta);
        state.renderedText = true;
        state.lineOpen = true;
      } else if (event.payload.type === 'tool.started') {
        if (state.lineOpen) output.write('\n');
        console.log(`[tool] ${event.payload.toolName} started`);
        state.lineOpen = false;
      } else if (event.payload.type === 'tool.completed') {
        console.log(
          `[tool] ${event.payload.toolName} ${event.payload.status} ${event.payload.elapsedMs}ms`,
        );
      } else if (event.payload.type === 'model.retry') {
        console.log(`[model] retry ${event.payload.attempt} (${event.payload.code})`);
      }
    },
    finish() {
      if (state.lineOpen) output.write('\n');
      state.lineOpen = false;
    },
  };
}
