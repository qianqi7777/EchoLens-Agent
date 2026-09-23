import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { isToolCallItem, textMessage, type ToolCallItem } from '../../../../src/core/messages.js';
import type { ModelProvider, ProviderCapabilities, ProviderRequest, ProviderResult } from '../../../../src/providers/types.js';
import { ReactAgent } from '../../../../src/runtime/resumable-react-agent.js';
import { ToolExecutor } from '../../../../src/runtime/tool-executor.js';
import { ToolRegistry } from '../../../../src/runtime/tool-registry.js';
import { objectSchema } from '../../../../src/runtime/tool-schema.js';
import { toolSuccess } from '../../../../src/runtime/tool-result.js';
import { registerSandboxTools } from '../../../../src/runtime/sandbox-tools.js';
import type { SandboxAdapter, SandboxExecuteRequest, SandboxExecuteResult } from '../../../../src/sandbox/types.js';
import type { AgentEvent } from '../../../../src/session/events.js';
import { parseVerificationGate } from '../../../../src/runtime/verification.js';

class ScriptedModel implements ModelProvider {
  readonly model = 'automatic-verification-test';
  readonly capabilities: ProviderCapabilities = {
    maxContextTokens: 8_192, supportsStreaming: false, supportsToolCalls: true,
    supportsParallelToolCalls: false, supportsStructuredOutput: true,
    supportsPromptCaching: false, supportsUsageReporting: false,
  };
  calls = 0;
  constructor(private readonly response: (turn: number, request: ProviderRequest) => ProviderResult) {}
  async complete(request: ProviderRequest): Promise<ProviderResult> {
    this.calls += 1;
    return this.response(this.calls, request);
  }
}

class SequenceSandbox implements SandboxAdapter {
  readonly capabilities = {
    adapter: 'docker' as const, isolation: 'high' as const, networkModes: ['none'] as const,
    resourceLimits: true, artifactCollection: true, hostExecution: false as const,
  };
  readonly requests: SandboxExecuteRequest[] = [];
  constructor(private readonly results: SandboxExecuteResult[]) {}
  async execute(request: SandboxExecuteRequest): Promise<SandboxExecuteResult> {
    this.requests.push(request);
    const result = this.results.shift();
    if (!result) throw new Error('unexpected Sandbox invocation');
    return result;
  }
}

const passed: SandboxExecuteResult = {
  status: 'passed', exitCode: 0, stdout: 'ok', stderr: '', durationMs: 1,
  outputTruncated: false, artifacts: [],
};
const failed: SandboxExecuteResult = {
  status: 'failed', exitCode: 1, stdout: 'test failed', stderr: '', durationMs: 1,
  outputTruncated: false, artifacts: [],
};

test('AGENT_VERIFY_GATE defaults to auto and rejects unsupported values', () => {
  assert.equal(parseVerificationGate(undefined), 'auto');
  assert.equal(parseVerificationGate('off'), 'off');
  assert.equal(parseVerificationGate('strict'), 'strict');
  assert.throws(() => parseVerificationGate('yes'), /AGENT_VERIFY_GATE/u);
});

test('approved plan verification triggers Sandbox verification even when the write result has no changedFiles', async () => {
  const root = await workspace();
  const sandbox = new SequenceSandbox([passed]);
  const registry = setup(sandbox, [] ).registry;
  const model = finalAfterWrite();
  const events: AgentEvent[] = [];
  const result = await new ReactAgent(model, registry,
    new ToolExecutor(registry, { actionGuardrail: writeAndVerifyGuardrail() }), {
      workspaceRoot: root, permissions: new Set(['workspace.read', 'workspace.write', 'process.exec']),
      verificationGate: 'auto',
    }).run('按计划写入', [], undefined, {
      approvedPlan: {
        objective: '完成修改',
        steps: [{ id: 'step-1', objective: '实现代码', verification: '运行测试', evidenceRequired: [] }],
        risks: [], completionCriteria: [],
      },
      onEvent: (event) => { events.push(event); },
    });
  assert.equal(result.state, 'completed');
  assert.equal(sandbox.requests.length, 1);
  assert.equal(events.some((event) => event.payload.type === 'verification.completed' && event.payload.verified), true);
});

test('a successful write batch verifies its combined changed files once', async () => {
  const root = await workspace();
  const sandbox = new SequenceSandbox([passed]);
  const registry = setup(sandbox, ['src/one.ts', 'src/two.ts']).registry;
  const model = new ScriptedModel((turn) => turn === 1
    ? multipleToolResponse(['write-one', 'write-two'])
    : { output: [textMessage('done', 'assistant', '已完成。')], stopReason: 'completed' });
  const result = await new ReactAgent(model, registry,
    new ToolExecutor(registry, { actionGuardrail: writeAndVerifyGuardrail() }), {
      workspaceRoot: root, permissions: new Set(['workspace.read', 'workspace.write', 'process.exec']),
      verificationGate: 'auto',
    }).run('批量写入', []);
  assert.equal(result.state, 'completed');
  assert.equal(sandbox.requests.length, 1);
  const verificationCall = result.items.find((item) => isToolCallItem(item) && item.name === 'verify_changes');
  assert.ok(verificationCall && isToolCallItem(verificationCall));
  assert.deepEqual(verificationCall.arguments.changedFiles, ['src/one.ts', 'src/two.ts']);
});

test('an empty verification plan is recorded as skipped, never as passed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'echolens-empty-verify-'));
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'no-checks' }));
  const sandbox = new SequenceSandbox([]);
  const registry = setup(sandbox, ['assets/logo.bin']).registry;
  const events: AgentEvent[] = [];
  const result = await new ReactAgent(finalAfterWrite(), registry,
    new ToolExecutor(registry, { actionGuardrail: writeAndVerifyGuardrail() }), {
      workspaceRoot: root, permissions: new Set(['workspace.read', 'workspace.write', 'process.exec']),
      verificationGate: 'auto',
    }).run('写入资源', [], undefined, { onEvent: (event) => { events.push(event); } });
  assert.equal(result.state, 'completed');
  assert.equal(sandbox.requests.length, 0);
  assert.equal(events.some((event) => event.payload.type === 'verification.skipped'), true);
  assert.equal(events.some((event) => event.payload.type === 'verification.completed' && event.payload.verified), false);
});

test('automatic verification feeds a failure back, accepts repair, and stays on Sandbox', async () => {
  const root = await workspace();
  const sandbox = new SequenceSandbox([failed, passed]);
  const { registry } = setup(sandbox);
  const events: AgentEvent[] = [];
  const model = new ScriptedModel((turn) => turn === 1
    ? toolResponse('write-1', 'write_file')
    : turn === 2
      ? toolResponse('write-2', 'write_file')
      : { output: [textMessage('done', 'assistant', '验证通过并完成修复。')], stopReason: 'completed' });
  const result = await new ReactAgent(model, registry, new ToolExecutor(registry, { actionGuardrail: writeAndVerifyGuardrail() }), {
    workspaceRoot: root, permissions: new Set(['workspace.read', 'workspace.write', 'process.exec']),
    verificationGate: 'auto',
  }).run('更改并验证', [], undefined, { onEvent: (event) => { events.push(event); } });

  assert.equal(result.state, 'completed');
  assert.equal(model.calls, 3);
  assert.deepEqual(sandbox.requests.map((request) => request.kind), ['test', 'test']);
  assert.ok(sandbox.requests.every((request) => request.network.mode === 'none'));
  assert.equal(events.filter((event) => event.payload.type === 'verification.started').length, 2);
  assert.equal(events.some((event) => event.payload.type === 'verification.completed'
    && !event.payload.verified && event.payload.results?.some((item) => item.status === 'failed')), true);
  assert.equal(events.some((event) => event.payload.type === 'verification.completed' && event.payload.verified), true);
  assert.equal(result.checkpoint.toolCallsUsed, 4, '写工具与自动验证都计入 Executor 预算');
  assert.deepEqual(result.checkpoint.internalVerificationCallIds, [], '已执行的内部授权不能被重放');
});

test('model cannot forge the internal automatic-verification approval', async () => {
  const root = await workspace();
  const sandbox = new SequenceSandbox([passed]);
  const { registry } = setup(sandbox);
  const model = new ScriptedModel((turn) => turn === 1
    ? toolResponse('forged-verify', 'verify_changes', { changedFiles: ['src/example.ts'] })
    : { output: [textMessage('unexpected', 'assistant', '不应运行')], stopReason: 'completed' });
  const events: AgentEvent[] = [];
  const result = await new ReactAgent(model, registry, new ToolExecutor(registry), {
    workspaceRoot: root, permissions: new Set(['workspace.read', 'process.exec']),
    verificationGate: 'auto',
  }).run('验证', [], undefined, { onEvent: (event) => { events.push(event); } });
  assert.equal(result.state, 'paused');
  assert.equal(sandbox.requests.length, 0);
  assert.equal(events.some((event) => event.payload.type === 'run.paused'
    && event.payload.reason === 'approval_required'), true);
});

test('two consecutive verification failures pause rather than loop', async () => {
  const root = await workspace();
  const sandbox = new SequenceSandbox([failed, failed]);
  const { registry } = setup(sandbox);
  const model = new ScriptedModel((turn) => toolResponse(`write-${turn}`, 'write_file'));
  const events: AgentEvent[] = [];
  const result = await new ReactAgent(model, registry, new ToolExecutor(registry, { actionGuardrail: writeAndVerifyGuardrail() }), {
    workspaceRoot: root, permissions: new Set(['workspace.read', 'workspace.write', 'process.exec']),
    verificationGate: 'auto',
  }).run('改动并尝试修复', [], undefined, { onEvent: (event) => { events.push(event); } });
  assert.equal(result.state, 'paused');
  assert.equal(model.calls, 2);
  assert.equal(events.some((event) => event.payload.type === 'run.paused'
    && event.payload.reason === 'verification_failed'), true);
});

test('off does not verify, auto skips unavailable Sandbox, and strict pauses on unavailable Sandbox', async () => {
  const offRoot = await workspace();
  const off = new SequenceSandbox([]);
  const offSetup = setup(off);
  const offEvents: AgentEvent[] = [];
  await new ReactAgent(finalAfterWrite(), offSetup.registry, new ToolExecutor(offSetup.registry, { actionGuardrail: writeAndVerifyGuardrail() }), {
    workspaceRoot: offRoot, permissions: new Set(['workspace.read', 'workspace.write', 'process.exec']),
    verificationGate: 'off',
  }).run('写入', [], undefined, { onEvent: (event) => { offEvents.push(event); } });
  assert.equal(off.requests.length, 0);
  assert.equal(offEvents.some((event) => event.payload.type === 'verification.started'
    || event.payload.type === 'verification.skipped'), false);

  const autoRoot = await workspace();
  const unavailable = new UnavailableSandbox();
  const auto = setup(unavailable);
  const autoEvents: AgentEvent[] = [];
  const autoResult = await new ReactAgent(finalAfterWrite(), auto.registry, new ToolExecutor(auto.registry, { actionGuardrail: writeAndVerifyGuardrail() }), {
    workspaceRoot: autoRoot, permissions: new Set(['workspace.read', 'workspace.write', 'process.exec']),
    verificationGate: 'auto',
  }).run('写入', [], undefined, { onEvent: (event) => { autoEvents.push(event); } });
  assert.equal(autoResult.state, 'completed');
  assert.equal(autoEvents.some((event) => event.payload.type === 'verification.skipped'
    && /Sandbox 不可用/u.test(event.payload.reason)), true);
  assert.equal(autoEvents.some((event) => event.payload.type === 'verification.completed'
    && event.payload.verified), false);

  const launchFailureRoot = await workspace();
  const launchFailure = setup(new UnavailableSandbox('sandbox_launch_failed'));
  const launchFailureEvents: AgentEvent[] = [];
  const launchFailureResult = await new ReactAgent(finalAfterWrite(), launchFailure.registry,
    new ToolExecutor(launchFailure.registry, { actionGuardrail: writeAndVerifyGuardrail() }), {
      workspaceRoot: launchFailureRoot, permissions: new Set(['workspace.read', 'workspace.write', 'process.exec']),
      verificationGate: 'auto',
    }).run('写入', [], undefined, { onEvent: (event) => { launchFailureEvents.push(event); } });
  assert.equal(launchFailureResult.state, 'completed');
  assert.equal(launchFailureEvents.some((event) => event.payload.type === 'verification.skipped'), true);
  assert.equal(launchFailureEvents.some((event) => event.payload.type === 'verification.completed'
    && event.payload.verified), false);

  const strictRoot = await workspace();
  const strict = setup(new UnavailableSandbox());
  const strictEvents: AgentEvent[] = [];
  const strictResult = await new ReactAgent(finalAfterWrite(), strict.registry, new ToolExecutor(strict.registry, { actionGuardrail: writeAndVerifyGuardrail() }), {
    workspaceRoot: strictRoot, permissions: new Set(['workspace.read', 'workspace.write', 'process.exec']),
    verificationGate: 'strict',
  }).run('写入', [], undefined, { onEvent: (event) => { strictEvents.push(event); } });
  assert.equal(strictResult.state, 'paused');
  assert.equal(strictEvents.some((event) => event.payload.type === 'verification.completed'
    && event.payload.verified), false);
});

function setup(sandbox: SandboxAdapter, changedFiles: string[] = ['src/example.ts']) {
  const registry = new ToolRegistry();
  registry.register({
    name: 'write_file', description: 'test write', permission: 'workspace.write', effect: 'write',
    inputSchema: objectSchema({}, []),
    execute: async () => toolSuccess('changed', 'changed', [], { changedFiles }),
  });
  registerSandboxTools(registry, sandbox);
  return { registry };
}

function writeAndVerifyGuardrail() {
  return {
    async evaluate(tool: { name: string; permission: string; effect?: string }, args: Record<string, unknown>, context: Parameters<import('../../../../src/runtime/action-guardrail.js').ProposedActionGuardrail['evaluate']>[2]) {
      if (tool.name === 'write_file') return {
        decision: 'allow' as const, reasonCode: 'test_write_allowed', reason: 'test', normalizedArguments: args,
      };
      const { DefaultProposedActionGuardrail } = await import('../../../../src/runtime/action-guardrail.js');
      return new DefaultProposedActionGuardrail().evaluate(
        tool as Parameters<import('../../../../src/runtime/action-guardrail.js').ProposedActionGuardrail['evaluate']>[0], args, context,
      );
    },
  };
}

function finalAfterWrite(): ScriptedModel {
  return new ScriptedModel((turn) => turn === 1
    ? toolResponse('write-1', 'write_file')
    : { output: [textMessage('done', 'assistant', '已完成。')], stopReason: 'completed' });
}

function toolResponse(callId: string, name: string, arguments_: Record<string, unknown> = {}): ProviderResult {
  const call: ToolCallItem = { type: 'tool_call', id: `${callId}-item`, callId, name, arguments: arguments_, callIndex: 0 };
  return { output: [textMessage(`${callId}-assistant`, 'assistant', ''), call], stopReason: 'tool_calls' };
}

function multipleToolResponse(callIds: string[]): ProviderResult {
  const calls: ToolCallItem[] = callIds.map((callId, callIndex) => ({
    type: 'tool_call', id: `${callId}-item`, callId, name: 'write_file', arguments: {}, callIndex,
  }));
  return { output: [textMessage('multiple-assistant', 'assistant', ''), ...calls], stopReason: 'tool_calls' };
}

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'echolens-auto-verify-'));
  await writeFile(join(root, 'package.json'), JSON.stringify({ scripts: { typecheck: 'tsc --noEmit', test: 'node --test' } }));
  return root;
}

class UnavailableSandbox extends SequenceSandbox {
  constructor(private readonly code: 'sandbox_unavailable' | 'sandbox_launch_failed' = 'sandbox_unavailable') { super([]); }
  override async execute(): Promise<SandboxExecuteResult> {
    const { SandboxError } = await import('../../../../src/sandbox/types.js');
    throw new SandboxError(this.code, 'Docker unavailable');
  }
}
