// 用内存审批与假 Provider 验证“审批暂停 → 恢复”的编辑循环：不碰真实模型与网络。
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { textMessage, type ToolCallItem } from '../../../../src/core/messages.js';
import type { ModelProvider, ProviderRequest, ProviderResult, ProviderCapabilities } from '../../../../src/providers/types.js';
import { MemoryApprovalStore } from '../../../../src/runtime/approval.js';
import { ReactAgent } from '../../../../src/runtime/react-loop.js';
import { ToolExecutor } from '../../../../src/runtime/tool-executor.js';
import { ToolRegistry } from '../../../../src/runtime/tool-registry.js';
import { registerWorkspaceTools } from '../../../../src/runtime/workspace-tools.js';

test('Safe Edit Loop 在审批暂停后恢复并只写入批准的 Patch', async (context) => {
  // 临时目录隔离每次运行，after 钩子兜底清理，失败也不留垃圾。
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
    // 第一轮返回 undefined（未决定）触发暂停；第二轮才放行，模拟用户批准。
    approvalDecider: async () => approve ? { decision: 'allow', scope: 'once', decidedAt: new Date().toISOString() } : undefined,
  });
  const agent = new ReactAgent(provider, registry, executor, {
    workspaceRoot: root,
    permissions: new Set(['workspace.read', 'workspace.write']),
  });
  const paused = await agent.run('编辑文件');
  assert.equal(paused.state, 'paused');
  // 关键断言：暂停发生在补丁落盘之前，磁盘仍是旧内容——这是“审批后再写入”的时序保证。
  assert.equal(await readFile(join(root, 'file.txt'), 'utf8'), 'before\n');
  approve = true;
  const resumed = await agent.resume(paused.checkpoint);
  assert.equal(resumed.state, 'completed');
  assert.equal(await readFile(join(root, 'file.txt'), 'utf8'), 'after\n');
});
