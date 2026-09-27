import type { FeatureIndexEntry } from './types.js';

export const ECHOLENS_FEATURES: readonly FeatureIndexEntry[] = [
  feature('startup-routing', '启动配置、凭据与模型路由', ['模型路由', '模型选择', '凭据', '启动配置', 'fallback'], ['路由', 'profile', 'credential', 'beginRun'], [
    implementation('src/runtime/model-routing.ts', ['classifyTask', 'RoutedModelProvider'], 100), config('src/runtime/model-routing-config.ts', 90),
    entry('src/config/startup-config.ts', 80), test('agent-test/tests/src/runtime/model-routing.test.ts', 70), docs('doc/功能链路/01-启动配置凭据与模型路由.md', 50),
  ], ['requiresTools', 'beginRun', 'fallback', 'classifyTask']),
  feature('conversation-runtime', '对话运行、工具调用与会话恢复', ['会话恢复', '工具调用', 'ReactAgent', 'checkpoint', '对话运行'], ['恢复', 'session', 'tool call', 'checkpoint'], [
    implementation('src/runtime/resumable-react-agent.ts', ['ReactAgent'], 100), implementation('src/session/session-runtime.ts', ['SessionRuntime'], 90),
    implementation('src/session/events.ts', [], 80), test('agent-test/tests/src/session/session-runtime.test.ts', 70), docs('doc/功能链路/02-对话运行工具调用与会话恢复.md', 50),
  ], ['pendingToolCalls', 'saveCheckpoint', 'resume', 'tool.completed']),
  feature('context-mcp-code', '规则、上下文、MCP 与代码智能', ['上下文', 'MCP', '代码智能', 'AGENTS', 'tree-sitter', 'LSP'], ['规则', 'context', 'symbol', 'definition'], [
    implementation('src/context/context-manager.ts', ['ContextManager'], 100), implementation('src/mcp/client-manager.ts', ['McpClientManager'], 90),
    implementation('src/code-intelligence/code-intelligence-service.ts', ['CodeIntelligenceService'], 90), test('agent-test/tests/src/code-intelligence/code-intelligence.test.ts', 70),
    docs('doc/功能链路/03-规则上下文MCP与代码智能.md', 50),
  ], ['ContextManager', 'registerCodeIntelligenceTools', 'McpClientManager', 'findSymbols']),
  feature('approval-sandbox', '审批、编辑、Sandbox 与验证', ['审批', 'Sandbox', '沙箱', '编辑', '验证', 'apply_patch'], ['approval', 'patch', 'sandbox', 'verification'], [
    implementation('src/runtime/tool-executor.ts', ['ToolExecutor'], 100), implementation('src/runtime/structured-patch.ts', ['applyPatch'], 90),
    implementation('src/sandbox/docker-sandbox.ts', ['DockerSandboxAdapter'], 80), test('agent-test/tests/src/runtime/approval.test.ts', 70), docs('doc/功能链路/04-审批编辑Sandbox与验证.md', 50),
  ], ['approval_required', 'invokeWithDecision', 'applyPatch', 'verify']),
  feature('subagents', '子 Agent、后台任务与隔离工作区', ['子Agent', '子 Agent', '后台任务', '隔离工作区', 'worktree'], ['subagent', 'background', 'task queue'], [
    implementation('src/orchestration/subagent.ts', ['SubagentOrchestrator'], 100), implementation('src/orchestration/background-worker.ts', [], 85),
    implementation('src/orchestration/task-queue.ts', ['PersistentTaskQueue'], 85), test('agent-test/tests/src/orchestration/subagent.test.ts', 70), docs('doc/功能链路/05-子Agent后台任务与隔离工作区.md', 50),
  ], ['SubagentOrchestrator', 'PersistentTaskQueue', 'lease', 'workspace']),
  feature('model-gateway', 'Model Gateway 认证、代理与用量', ['Model Gateway', '网关', '认证代理', '用量', '额度'], ['gateway', 'token', 'quota', 'usage'], [
    entry('server/model-gateway/src/main.ts', 100), implementation('server/model-gateway/src/server.ts', ['createGatewayServer'], 90), implementation('server/model-gateway/src/state-store.ts', ['GatewayStateStore'], 80),
    test('agent-test/tests/server/model-gateway/src/server.test.ts', 70), docs('doc/功能链路/06-Model-Gateway认证代理与用量.md', 50),
  ], ['auth', 'usage', 'quota', 'proxy']),
  feature('evals', 'Eval 评测与动态任务', ['Eval', '评测', '动态任务', '评分'], ['eval', 'grader', 'metrics', 'candidate'], [
    entry('agent-test/src/eval-cli.ts', 100), implementation('agent-test/src/evals/harness.ts', ['EvalHarness'], 90), implementation('agent-test/src/evals/metrics.ts', ['calculateRunMetrics'], 80),
    test('agent-test/tests/src/evals/eval-harness.test.ts', 70), docs('doc/功能链路/07-Eval评测与动态任务.md', 50),
  ], ['EvalHarness', 'metrics', 'grade', 'publicTask']),
  feature('workspace-switching', '工作目录切换', ['工作目录切换', '工作区切换', '/cd', '/workspace'], ['workspace manager', '切换目录'], [
    implementation('src/runtime/workspace-manager.ts', ['WorkspaceRuntimeManager'], 100), entry('src/cli.ts', 80),
    test('agent-test/tests/src/runtime/workspace-manager.test.ts', 70), docs('doc/功能链路/08-工作目录切换.md', 50),
  ], ['resolveWorkspaceDirectory', 'WorkspaceRuntimeManager', 'workspaceRoot']),
  feature('test-workbench', '测试工作台与 Issue 对比', ['测试工作台', 'Issue 对比', 'agent-test web'], ['compare', 'issue', 'provider quality'], [
    entry('agent-test/src/server.ts', 100), implementation('agent-test/src/engine.ts', ['runComparison'], 90), test('agent-test/tests/agent-test/engine.test.ts', 70),
    docs('doc/功能链路/09-测试工作台与Issue对比.md', 50),
  ], ['runComparison', 'runIssue', 'ProviderSummary']),
];

function feature(id: string, title: string, aliases: string[], triggers: string[], locations: FeatureIndexEntry['locations'], searchHints: string[]): FeatureIndexEntry {
  const preferredTools: FeatureIndexEntry['preferredTools'] = locations.some((item) => item.symbols?.length)
    ? ['find_symbols', 'read_file']
    : ['read_file', 'workspace_search'];
  return { id, title, aliases, triggers, locations, searchHints, preferredTools };
}
function location(path: string, kind: FeatureIndexEntry['locations'][number]['kind'], symbols: string[], priority: number) {
  return { path, kind, symbols: symbols.length ? symbols : undefined, priority };
}
function entry(path: string, priority: number) { return location(path, 'entry', [], priority); }
function implementation(path: string, symbols: string[], priority: number) { return location(path, 'implementation', symbols, priority); }
function test(path: string, priority: number) { return location(path, 'test', [], priority); }
function docs(path: string, priority: number) { return location(path, 'docs', [], priority); }
function config(path: string, priority: number) { return location(path, 'config', [], priority); }
