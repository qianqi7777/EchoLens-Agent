import { ModelRouter } from '../../src/runtime/model-router.js';
import { ReactAgent } from '../../src/runtime/resumable-react-agent.js';
import { ToolExecutor } from '../../src/runtime/tool-executor.js';
import { ToolRegistry } from '../../src/runtime/tool-registry.js';
import { registerWorkspaceTools } from '../../src/runtime/workspace-tools.js';
import type { AgentEvent } from '../../src/session/events.js';

const prompt = process.argv[2]?.trim();
if (!prompt) throw new Error('缺少 Issue prompt');

const router = ModelRouter.fromEnv();
const connection = await router.connect();
if (!connection.provider) {
  throw new Error(`EchoLens 模型路由不可用：${connection.status.reasonCode}`);
}

const registry = new ToolRegistry();
registerWorkspaceTools(registry);
const executor = new ToolExecutor(registry, {
  approvalDecider: async () => ({
    decision: 'allow',
    scope: 'once',
    decidedAt: new Date().toISOString(),
    reason: 'agent-test 隔离副本允许结构化文件修改',
  }),
  timeoutMs: 120_000,
});
const agent = new ReactAgent(connection.provider, registry, executor, {
  workspaceRoot: process.cwd(),
  permissions: new Set(['workspace.read', 'workspace.write']),
  privacy: connection.status.privacy,
});
const events: AgentEvent[] = [];
const result = await agent.run([
  '在当前隔离仓库中解决下面的 GitHub Issue。先检查代码，再用结构化 Patch 修改。',
  '不要只解释方案；完成后简要列出发现的问题。',
  '',
  prompt,
].join('\n'), [], undefined, { onEvent: (event) => { events.push(event); } });

const foundBugs = (result.answer.match(/\b(?:bug|issue|错误|缺陷|问题)\b/giu) ?? []).length;
process.stdout.write(JSON.stringify({
  foundBugs,
  state: result.state,
  answer: result.answer.slice(0, 20_000),
  changedFiles: events.flatMap((event) => event.payload.type === 'tool.completed' && event.payload.toolName === 'apply_patch'
    ? event.payload.evidenceIds : []),
}));
