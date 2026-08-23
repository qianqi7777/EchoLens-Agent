import * as readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import {
  ModelRouter,
  ReactAgent,
  ToolExecutor,
  ToolRegistry,
  registerWorkspaceTools,
  type ChatMessage,
  type ModelRoute,
} from './runtime/index.js';

const route = (process.env.AGENT_MODEL_ROUTE ?? 'local') as ModelRoute;
const workspaceRoot = process.env.AGENT_WORKSPACE_ROOT ?? process.cwd();
const registry = new ToolRegistry();
registerWorkspaceTools(registry);

const router = ModelRouter.fromEnv();
const status = router.status(route);
const model = router.build(route);
if (!model) {
  console.error(`模型路由 ${route} 未配置：${status.reason}`);
  console.error('请参考 .env.example 配置当前 shell 后重试。');
  process.exitCode = 1;
} else {
  const agent = new ReactAgent(model, registry, new ToolExecutor(registry), {
    workspaceRoot,
    permissions: new Set(['workspace.read']),
  });
  const terminal = readline.createInterface({ input, output });
  const history: ChatMessage[] = [];

  console.log(`Agent 已启动 | model=${status.model} | route=${route} | workspace=${workspaceRoot}`);
  console.log('输入问题开始分析，输入 /exit 退出。');
  try {
    while (true) {
      const prompt = (await terminal.question('\n> ')).trim();
      if (!prompt) continue;
      if (prompt === '/exit' || prompt === '/quit') break;
      try {
        const result = await agent.run(prompt, history);
        console.log(`\n${result.answer}`);
        history.push({ role: 'user', content: prompt }, { role: 'assistant', content: result.answer });
      } catch (error) {
        console.error(`运行失败：${error instanceof Error ? error.message : String(error)}`);
      }
    }
  } finally {
    terminal.close();
  }
}
