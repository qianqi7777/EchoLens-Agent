import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { CommandHookManager, HookConfigError } from '../../../../src/orchestration/command-hooks.js';
import { LifecycleHookRunner } from '../../../../src/orchestration/lifecycle-hooks.js';
import { textMessage, type ToolCallItem } from '../../../../src/core/messages.js';
import type { ModelProvider, ProviderRequest, ProviderResult } from '../../../../src/providers/types.js';
import { ReactAgent } from '../../../../src/runtime/resumable-react-agent.js';
import { SessionRuntime } from '../../../../src/session/session-runtime.js';
import { ToolExecutor } from '../../../../src/runtime/tool-executor.js';
import { ToolRegistry } from '../../../../src/runtime/tool-registry.js';
import { toolSuccess } from '../../../../src/runtime/tool-result.js';

test('用户 Hook 注入有界上下文且环境变量默认不继承', async (t) => {
  const { root, home } = await fixture(t);
  await writeFile(join(root, 'context.mjs'), `
let text = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { text += chunk; });
process.stdin.on('end', () => {
  const input = JSON.parse(text);
  console.log(JSON.stringify({ version: 1,
    additionalContext: input.hookEventName + ':' + process.env.ALLOWED_VALUE + ':' + (process.env.SECRET_VALUE ? 'leaked' : 'clean') }));
});
`);
  await writeConfig(join(home, 'hooks.json'), {
    UserPromptSubmit: [hook('context', 'context.mjs', { envFrom: ['ALLOWED_VALUE'] })],
  });
  const manager = await CommandHookManager.load(root, {
    env: { ...process.env, ECHOLENS_HOME: home, ALLOWED_VALUE: 'yes', SECRET_VALUE: 'hidden' },
  });
  const result = await manager.run(input(root, 'UserPromptSubmit', { prompt: 'hello' }));
  assert.equal(result.decision, 'continue');
  assert.equal(result.contexts[0]?.content, 'UserPromptSubmit:yes:clean');
  assert.match(result.contexts[0]?.contentHash ?? '', /^sha256:[a-f0-9]{64}$/u);
});

test('项目 Hook 默认跳过，信任后可拒绝，脚本变化使指纹失效', async (t) => {
  const { root, home } = await fixture(t);
  const script = join(root, 'policy.mjs');
  await writeFile(script, "process.stdin.resume(); process.stdin.on('end', () => { console.error('blocked'); process.exit(2); });\n");
  await writeConfig(join(root, '.echolens', 'hooks.json'), {
    PreToolUse: [{ ...hook('policy', 'policy.mjs'), matcher: { tools: ['shell_*'] }, trustFiles: ['policy.mjs'] }],
  });
  const manager = await CommandHookManager.load(root, { env: { ...process.env, ECHOLENS_HOME: home } });
  const request = input(root, 'PreToolUse', { toolName: 'shell_exec', toolInput: { command: 'test' } });
  const skipped = await manager.run(request);
  assert.equal(skipped.decision, 'continue');
  assert.equal(skipped.results[0]?.reasonCode, 'project_hook_not_trusted');

  await manager.trustProject('policy');
  assert.equal((await manager.run(request)).decision, 'deny');
  assert.equal(manager.list()[0]?.trusted, true);
  const trustFile = await readFile(join(root, '.echolens', 'hook-trust.json'), 'utf8');
  assert.doesNotMatch(trustFile, /blocked/u);

  await writeFile(script, "process.stdin.resume(); process.stdin.on('end', () => process.exit(0));\n");
  const changed = await manager.run(request);
  assert.equal(changed.results[0]?.reasonCode, 'project_hook_not_trusted');
  assert.equal(manager.list()[0]?.trusted, false);
});

test('决策 Hook 默认 fail-closed，完成后 Hook 始终 fail-open', async (t) => {
  const { root, home } = await fixture(t);
  await writeConfig(join(home, 'hooks.json'), {
    PreToolUse: [hook('missing-pre', 'missing-command')],
    PostToolUse: [hook('missing-post', 'missing-command', { failureMode: 'closed' })],
  });
  const manager = await CommandHookManager.load(root, { env: { ...process.env, ECHOLENS_HOME: home } });
  const before = await manager.run(input(root, 'PreToolUse', { toolName: 'read_file' }));
  const after = await manager.run(input(root, 'PostToolUse', { toolName: 'read_file' }));
  assert.equal(before.decision, 'deny');
  assert.equal(before.results[0]?.reasonCode, 'hook_exit_nonzero');
  assert.equal(after.decision, 'continue');
});

test('超时和超量输出稳定失败且不会悬挂', async (t) => {
  const { root, home } = await fixture(t);
  await writeFile(join(root, 'slow.mjs'), 'setInterval(() => undefined, 1000);\n');
  await writeFile(join(root, 'loud.mjs'), "process.stdout.write('x'.repeat(40000));\n");
  await writeConfig(join(home, 'hooks.json'), {
    UserPromptSubmit: [
      hook('slow', 'slow.mjs', { timeoutMs: 100 }),
      hook('loud', 'loud.mjs'),
    ],
  });
  const manager = await CommandHookManager.load(root, { env: { ...process.env, ECHOLENS_HOME: home } });
  const result = await manager.run(input(root, 'UserPromptSubmit'));
  assert.equal(result.decision, 'deny');
  assert.deepEqual(result.results.map((item) => item.reasonCode), ['hook_timeout', 'hook_output_too_large']);
});

test('非法配置拒绝初始化，项目入口脚本必须纳入信任指纹', async (t) => {
  const { root, home } = await fixture(t);
  await writeFile(join(root, 'entry.mjs'), '');
  await writeConfig(join(root, '.echolens', 'hooks.json'), {
    PreToolUse: [hook('entry', 'entry.mjs')],
  });
  await assert.rejects(
    CommandHookManager.load(root, { env: { ...process.env, ECHOLENS_HOME: home } }),
    (error: unknown) => error instanceof HookConfigError && /trustFiles/u.test(error.message),
  );
});

test('工具预检只能拒绝且不消耗预算，放行后仍进入原审批链', async () => {
  const registry = new ToolRegistry();
  let executions = 0;
  registry.register({
    name: 'write_test', description: 'test', permission: 'workspace.write', effect: 'write',
    inputSchema: { type: 'object', additionalProperties: false },
    execute: async () => { executions += 1; return toolSuccess('ok', 'ok'); },
  });
  const executor = new ToolExecutor(registry);
  const context = {
    workspaceRoot: process.cwd(),
    allowedPermissions: new Set(['workspace.write'] as const),
    signal: new AbortController().signal,
  };
  const denied = await executor.invokeWithDecision('write_test', {}, context, undefined, undefined,
    async () => ({ decision: 'deny', reason: 'policy' }));
  assert.equal(denied.result.error?.code, 'hook_denied');
  assert.equal(executor.callsUsed(), 0);
  const approval = await executor.invokeWithDecision('write_test', {}, context);
  assert.equal(approval.result.error?.code, 'approval_required');
  assert.equal(executions, 0);
});

test('Prompt 上下文进入模型且只注入一次并写入审计事件', async (t) => {
  const { root, home } = await fixture(t);
  await writeFile(join(root, 'prompt.mjs'), `
process.stdin.resume();
process.stdin.on('end', () => console.log(JSON.stringify({ version: 1, additionalContext: 'hook-guidance' })));
`);
  await writeFile(join(root, 'noop.mjs'), 'process.stdin.resume();\n');
  await writeConfig(join(home, 'hooks.json'), {
    SessionStart: [hook('session-start', 'noop.mjs')],
    UserPromptSubmit: [hook('prompt-context', 'prompt.mjs')],
    SessionEnd: [hook('session-end', 'noop.mjs')],
  });
  const hooks = await LifecycleHookRunner.load(root, { env: { ...process.env, ECHOLENS_HOME: home } });
  const requests: ProviderRequest[] = [];
  const provider = finalProvider(requests);
  const registry = new ToolRegistry();
  const session = await SessionRuntime.open(
    new ReactAgent(provider, registry, new ToolExecutor(registry), {
      workspaceRoot: root, navigationMode: 'off', hooks,
    }),
    { rootDirectory: join(root, 'sessions'), workspaceRoot: root, hooks },
  );
  await session.run('hello');
  const hookMessages = requests[0]?.items.filter((item) => item.type === 'message'
    && item.content.some((part) => part.text.includes('hook-guidance'))) ?? [];
  assert.equal(hookMessages.length, 1);
  const events = await session.store.read();
  assert.ok(events.some((event) => event.payload.type === 'hook.completed'
    && event.payload.hookEventName === 'UserPromptSubmit'));
  assert.ok(events.some((event) => event.payload.type === 'hook.completed'
    && event.payload.hookEventName === 'SessionStart'));
  await session.close();
  const persisted = (await readFile(session.store.filePath, 'utf8')).trim().split('\n')
    .map((line) => JSON.parse(line) as { payload: { type: string; hookEventName?: string } });
  assert.ok(persisted.some((event) => event.payload.type === 'hook.completed'
    && event.payload.hookEventName === 'SessionEnd'));
});

test('暂停后恢复沿用持久化 Hook 上下文且不重新运行 Prompt Hook', async (t) => {
  const { root, home } = await fixture(t);
  await writeFile(join(root, 'prompt.mjs'), `
process.stdin.resume();
process.stdin.on('end', () => console.log(JSON.stringify({ version: 1, additionalContext: 'resume-guidance' })));
`);
  await writeConfig(join(home, 'hooks.json'), {
    UserPromptSubmit: [hook('resume-context', 'prompt.mjs')],
  });
  const hooks = await LifecycleHookRunner.load(root, { env: { ...process.env, ECHOLENS_HOME: home } });
  const registry = new ToolRegistry();
  registry.register({
    name: 'inspect', description: 'inspect', permission: 'workspace.read', effect: 'read',
    inputSchema: { type: 'object', additionalProperties: false },
    execute: async () => toolSuccess('ok', 'ok'),
  });
  const firstProvider: ModelProvider = {
    ...finalProvider([]),
    async complete(): Promise<ProviderResult> {
      return { output: [textMessage('assistant', 'assistant', ''), {
        type: 'tool_call', id: 'item', callId: 'call', name: 'inspect', arguments: {}, callIndex: 0,
      }], stopReason: 'tool_calls' };
    },
  };
  const sessionId = 'resume-hooks';
  const sessionRoot = join(root, 'sessions');
  const first = await SessionRuntime.open(
    new ReactAgent(firstProvider, registry, new ToolExecutor(registry), {
      workspaceRoot: root, navigationMode: 'off', hooks, maxSteps: 1,
    }),
    { rootDirectory: sessionRoot, workspaceRoot: root, hooks, sessionId },
  );
  assert.equal((await first.run('inspect')).state, 'paused');
  await first.close();

  const requests: ProviderRequest[] = [];
  const resumed = await SessionRuntime.open(
    new ReactAgent(finalProvider(requests), registry, new ToolExecutor(registry), {
      workspaceRoot: root, navigationMode: 'off', hooks, maxSteps: 1,
    }),
    { rootDirectory: sessionRoot, workspaceRoot: root, hooks, sessionId },
  );
  await resumed.resume();
  const contexts = requests[0]?.items.filter((item) => item.type === 'message'
    && item.content.some((part) => part.text.includes('resume-guidance'))) ?? [];
  assert.equal(contexts.length, 1);
  const events = await resumed.store.read();
  assert.equal(events.filter((event) => event.payload.type === 'hook.completed'
    && event.payload.hookEventName === 'UserPromptSubmit').length, 1);
  await resumed.close();
});

test('PreToolUse deny 阻止工具且 PostToolUse 只观察加固结果', async (t) => {
  const { root, home } = await fixture(t);
  await writeFile(join(root, 'deny.mjs'), `
process.stdin.resume();
process.stdin.on('end', () => console.log(JSON.stringify({ version: 1, decision: 'deny', reason: 'policy denied' })));
`);
  await writeFile(join(root, 'observe.mjs'), 'process.stdin.resume();\n');
  await writeConfig(join(home, 'hooks.json'), {
    PreToolUse: [{ ...hook('deny-tool', 'deny.mjs'), matcher: { tools: ['inspect'] } }],
    PostToolUse: [{ ...hook('observe-tool', 'observe.mjs'), matcher: { tools: ['inspect'] } }],
  });
  const hooks = await LifecycleHookRunner.load(root, { env: { ...process.env, ECHOLENS_HOME: home } });
  const requests: ProviderRequest[] = [];
  let executions = 0;
  const registry = new ToolRegistry();
  registry.register({
    name: 'inspect', description: 'inspect', permission: 'workspace.read', effect: 'read',
    inputSchema: { type: 'object', additionalProperties: false },
    execute: async () => { executions += 1; return toolSuccess('secret result', 'ok'); },
  });
  let turn = 0;
  const provider: ModelProvider = {
    ...finalProvider(requests),
    async complete(request): Promise<ProviderResult> {
      requests.push(request);
      turn += 1;
      if (turn === 1) {
        const call: ToolCallItem = {
          type: 'tool_call', id: 'item', callId: 'call', name: 'inspect', arguments: {}, callIndex: 0,
        };
        return { output: [textMessage('assistant', 'assistant', ''), call], stopReason: 'tool_calls' };
      }
      return { output: [textMessage('final', 'assistant', 'corrected')], stopReason: 'completed' };
    },
  };
  const executor = new ToolExecutor(registry);
  const session = await SessionRuntime.open(
    new ReactAgent(provider, registry, executor, { workspaceRoot: root, navigationMode: 'off', hooks }),
    { rootDirectory: join(root, 'sessions'), workspaceRoot: root, hooks },
  );
  const result = await session.run('inspect');
  const events = await session.store.read();
  assert.equal(result.state, 'completed');
  assert.equal(executions, 0);
  assert.equal(executor.callsUsed(), 0);
  assert.equal(requests[1]?.items.find((item) => item.type === 'tool_result')?.error?.code, 'hook_denied');
  const sequence = events.filter((event) => event.payload.type === 'hook.completed'
    || event.payload.type === 'tool.completed').map((event) => event.payload.type === 'hook.completed'
      ? `${event.payload.hookEventName}:${event.payload.status}` : 'tool.completed');
  assert.deepEqual(sequence, ['PreToolUse:denied', 'tool.completed', 'PostToolUse:completed']);
  await session.close();
});

async function fixture(t: test.TestContext): Promise<{ root: string; home: string }> {
  const root = await mkdtemp(join(tmpdir(), 'echolens-hooks-'));
  const home = join(root, 'home');
  await mkdir(join(root, '.echolens'), { recursive: true });
  await mkdir(home, { recursive: true });
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, home };
}

function hook(
  id: string,
  script: string,
  options: { timeoutMs?: number; envFrom?: string[]; failureMode?: 'open' | 'closed' } = {},
) {
  return {
    id,
    handler: {
      type: 'command',
      executable: process.execPath,
      args: [script],
      timeoutMs: options.timeoutMs,
      envFrom: options.envFrom,
    },
    failureMode: options.failureMode,
  };
}

function input(root: string, hookEventName: Parameters<CommandHookManager['run']>[0]['hookEventName'], extra = {}) {
  return { version: 1 as const, hookEventName, sessionId: 'session', cwd: root, ...extra };
}

async function writeConfig(file: string, hooks: Record<string, unknown>): Promise<void> {
  await mkdir(join(file, '..'), { recursive: true });
  await writeFile(file, JSON.stringify({ version: 1, hooks }));
}

function finalProvider(requests: ProviderRequest[]): ModelProvider {
  return {
    model: 'local-hook-test',
    capabilities: {
      maxContextTokens: 8_192,
      supportsStreaming: false,
      supportsToolCalls: true,
      supportsParallelToolCalls: true,
      supportsStructuredOutput: false,
      supportsPromptCaching: false,
      supportsUsageReporting: false,
    },
    async complete(request): Promise<ProviderResult> {
      requests.push(request);
      return { output: [textMessage('final', 'assistant', 'done')], stopReason: 'completed' };
    },
  };
}
