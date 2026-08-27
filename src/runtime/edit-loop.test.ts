import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { textMessage, type ToolCallItem } from '../core/messages.js';
import type { ModelProvider, ProviderRequest, ProviderResult, ProviderCapabilities } from '../providers/types.js';
import { MemoryApprovalStore } from './approval.js';
import { ReactAgent } from './react-loop.js';
import { ToolExecutor } from './tool-executor.js';
import { ToolRegistry } from './tool-registry.js';
import { registerWorkspaceTools } from './workspace-tools.js';

test('Safe Edit Loop 在审批暂停后恢复并只写入批准的 Patch', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'echolens-edit-loop-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'file.txt'), 'before\n');
  const capabilities: ProviderCapabilities = {
    maxContextTokens: 8_192, supportsStreaming: false, supportsToolCalls: true,
    supportsParallelToolCalls: false, supportsStructuredOutput: true, supportsPromptCaching: false, supportsUsageReporting: false,
  };
  let calls = 0;
  const provider: ModelProvider = {
    model: 'edit-test', capabilities,
    async complete(_request: ProviderRequest): Promise<ProviderResult> {
      calls += 1;
      if (calls === 1) {
        const toolCall: ToolCallItem = {
          type: 'tool_call', id: 'patch-call', callId: 'patch-call', name: 'apply_patch', callIndex: 0,
          arguments: { patch: { version: 1, operations: [{ op: 'replace', path: 'file.txt', oldString: 'before', newString: 'after' }] } },
        };
        return { output: [textMessage('assistant-tools', 'assistant', ''), toolCall], stopReason: 'tool_calls' };
      }
      return { output: [textMessage('assistant-final', 'assistant', '已完成编辑。')], stopReason: 'completed' };
    },
  };
  let approve = false;
  const registry = new ToolRegistry();
  registerWorkspaceTools(registry);
  const executor = new ToolExecutor(registry, {
    approvalStore: new MemoryApprovalStore(),
    approvalDecider: async () => approve ? { decision: 'allow', scope: 'once', decidedAt: new Date().toISOString() } : undefined,
  });
  const agent = new ReactAgent(provider, registry, executor, {
    workspaceRoot: root,
    permissions: new Set(['workspace.read', 'workspace.write']),
  });
  const paused = await agent.run('编辑文件');
  assert.equal(paused.state, 'paused');
  assert.equal(await readFile(join(root, 'file.txt'), 'utf8'), 'before\n');
  approve = true;
  const resumed = await agent.resume(paused.checkpoint);
  assert.equal(resumed.state, 'completed');
  assert.equal(await readFile(join(root, 'file.txt'), 'utf8'), 'after\n');
});
