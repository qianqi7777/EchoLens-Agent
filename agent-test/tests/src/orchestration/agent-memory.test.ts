import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { AgentMemoryStore } from '../../../../src/orchestration/agent-memory.js';
import { SubagentOrchestrator, type SubagentProfile } from '../../../../src/orchestration/subagent.js';
import { ToolRegistry } from '../../../../src/runtime/tool-registry.js';
import { toolSuccess } from '../../../../src/runtime/tool-result.js';
import { textMessage } from '../../../../src/core/messages.js';
import type { ModelProvider } from '../../../../src/providers/types.js';

test('子 Agent 记忆跨实例保留，读取按行数截断且写入有大小上限', async (context) => {
  const home = await mkdtemp(join(tmpdir(), 'echolens-memory-')); context.after(() => rm(home, { recursive: true, force: true }));
  const first = new AgentMemoryStore({ homeDirectory: home, maxLines: 2, maxBytes: 256 });
  await first.write('explore', 'one\ntwo\nthree');
  const second = new AgentMemoryStore({ homeDirectory: home, maxLines: 2, maxBytes: 256 });
  const loaded = await second.read('explore');
  assert.equal(loaded.content, 'one\ntwo');
  assert.equal(loaded.truncated, true);
  await assert.rejects(() => second.write('explore', 'x'.repeat(257)), /超过/u);
  await assert.rejects(() => second.read('../escape'), /profile 无效/u);
});

test('不存在的 profile 记忆以空内容开始', async (context) => {
  const home = await mkdtemp(join(tmpdir(), 'echolens-memory-')); context.after(() => rm(home, { recursive: true, force: true }));
  const result = await new AgentMemoryStore({ homeDirectory: home }).read('review');
  assert.deepEqual(result, { content: '', truncated: false });
});

test('子 Agent profile 可固定独立模型，结果用量仍返回给任务层', async (context) => {
  const home = await mkdtemp(join(tmpdir(), 'echolens-memory-')); const workspace = await mkdtemp(join(tmpdir(), 'echolens-memory-ws-'));
  context.after(() => Promise.all([rm(home, { recursive: true, force: true }), rm(workspace, { recursive: true, force: true })]));
  const registry = new ToolRegistry();
  registry.register({ name: 'read_file', description: 'read', permission: 'workspace.read', effect: 'read', inputSchema: { type: 'object', additionalProperties: false }, execute: async () => toolSuccess('ok', 'ok', ['memory:test']) });
  const profile: SubagentProfile = { id: 'special', description: 'special', tools: new Set(['read_file']), permissions: new Set(['workspace.read']), maxSteps: 1, maxToolCalls: 1, workspaceMode: 'sandbox', autoApproveEffects: new Set(['read']), model: 'small' };
  let resolved = '';
  const base = new MemoryModel('base'); const special = new MemoryModel('special');
  const orchestrator = new SubagentOrchestrator(base, registry, workspace, {
    allocate: async () => ({ id: 'lease', mode: 'sandbox', root: workspace, workspaceKey: workspace, changedFiles: async () => [], cleanup: async () => undefined }),
  }, [profile], undefined, { modelResolver: (id) => { resolved = id; return special; }, memory: new AgentMemoryStore({ homeDirectory: home }) });
  const result = await orchestrator.run({ profile: 'special', objective: 'inspect' });
  assert.equal(resolved, 'small');
  assert.equal(special.calls > 0, true);
  assert.equal(base.calls, 0);
  assert.equal(result.usage.modelSteps, 1);
});

class MemoryModel implements ModelProvider {
  readonly capabilities = { maxContextTokens: 8_192, supportsStreaming: false, supportsToolCalls: false, supportsParallelToolCalls: false, supportsStructuredOutput: true, supportsPromptCaching: false, supportsUsageReporting: true };
  calls = 0;
  constructor(readonly model: string) {}
  async complete() { this.calls += 1; return { output: [textMessage('answer', 'assistant', JSON.stringify({ answer: this.model, changes: [], verification: [], unresolved: [], warnings: [] }))], stopReason: 'completed' as const, usage: { inputTokens: 2, outputTokens: 2, totalTokens: 4 } }; }
}
