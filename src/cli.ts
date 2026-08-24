import * as readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { ensureStartupConfiguration } from './config/startup-config.js';
import {
  ModelRouter,
  ReactAgent,
  ToolExecutor,
  ToolRegistry,
  registerWorkspaceTools,
  type ConversationItem,
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
  });
  const history: ConversationItem[] = [];

  console.log(`Agent 已启动 | model=${status.model} | route=${status.route} | workspace=${workspaceRoot}`);
  console.log('输入问题开始分析，输入 /exit 退出。');
  try {
    while (true) {
      const prompt = (await terminal.question('\n> ')).trim();
      if (!prompt) continue;
      if (prompt === '/exit' || prompt === '/quit') break;
      try {
        const result = await agent.run(prompt, history);
        console.log(`\n${result.answer}`);
        if (!result.finalSummary.verified) {
          console.error('结构化结果校验失败：以上内容作为未验证 raw 输出显示。');
        }
        history.splice(
          0,
          history.length,
          ...result.items.filter((item) => item.type !== 'message' || item.role !== 'system'),
        );
      } catch (error) {
        console.error(`运行失败：${error instanceof Error ? error.message : String(error)}`);
      }
    }
  } finally {
    terminal.close();
  }
}
