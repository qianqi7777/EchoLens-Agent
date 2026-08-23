import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ReactAgent } from './react-loop.js';
import { ToolExecutor } from './tool-executor.js';
import { ToolRegistry } from './tool-registry.js';
import type { ChatModel, ModelRequest, ModelResponse } from './types.js';
import { registerWorkspaceTools } from './workspace-tools.js';

class ScriptedModel implements ChatModel {
  readonly model = 'test-model';
  private turn = 0;

  async complete(_request: ModelRequest): Promise<ModelResponse> {
    this.turn += 1;
    if (this.turn === 1) {
      return { text: '', toolCalls: [{ id: 'call-1', name: 'read_file', arguments: { path: 'hello.ts' } }] };
    }
    return { text: '已读取目标文件。', toolCalls: [] };
  }
}

test('ReactAgent completes a tool round trip', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'agent-runtime-'));
  await writeFile(join(workspace, 'hello.ts'), 'export const hello = true;\n');
  const registry = new ToolRegistry();
  registerWorkspaceTools(registry);
  const result = await new ReactAgent(
    new ScriptedModel(),
    registry,
    new ToolExecutor(registry),
    { workspaceRoot: workspace },
  ).run('读取 hello.ts');

  assert.equal(result.answer, '已读取目标文件。');
  assert.equal(result.trace.some((item) => item.type === 'tool'), true);
  assert.equal(result.messages.some((message) => message.role === 'tool' && message.content.includes('hello')), true);
});

test('workspace tools reject paths outside the workspace', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'agent-runtime-'));
  const registry = new ToolRegistry();
  registerWorkspaceTools(registry);
  const executor = new ToolExecutor(registry);
  const result = await executor.invoke('read_file', { path: '..\\outside.txt' }, {
    workspaceRoot: workspace,
    allowedPermissions: new Set(['workspace.read']),
    signal: new AbortController().signal,
  });

  assert.equal(result.status, 'error');
  assert.match(result.content, /路径越界/);
});
