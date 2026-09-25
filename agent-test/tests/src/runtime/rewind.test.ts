import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { textMessage, type ConversationItem, type ToolResultItem } from '../../../../src/core/messages.js';
import { applyPatch, saveEditCheckpoint } from '../../../../src/runtime/structured-patch.js';
import { SessionRuntime } from '../../../../src/session/session-runtime.js';
import type { AgentCheckpoint } from '../../../../src/session/events.js';

async function setup(context: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'echolens-rewind-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'version.txt'), 'v0\n');
  const session = await SessionRuntime.open({} as import('../../../../src/runtime/resumable-react-agent.js').ReactAgent, {
    rootDirectory: join(root, 'sessions'), workspaceRoot: root, sessionId: 'rewind-session',
  });
  context.after(() => session.close().catch(() => undefined));
  return { root, session };
}

function checkpoint(sessionId: string, turnId: string, items: ConversationItem[], step: number): AgentCheckpoint {
  return {
    version: 1, sessionId, turnId, runId: `${turnId}-run`, step, phase: 'finished',
    toolCallsUsed: 0, state: 'completed', items,
  };
}

function patchResult(checkpointId: string): ToolResultItem {
  return {
    type: 'tool_result', id: `result-${checkpointId}`, callId: `call-${checkpointId}`, toolName: 'apply_patch',
    status: 'ok', output: {
      id: `output-${checkpointId}`, kind: 'tool_output', content: 'ok',
      source: { type: 'tool', toolName: 'apply_patch' }, trust: 'untrusted', redactions: [],
    }, summary: 'ok', data: { checkpointId }, evidenceIds: [],
  };
}

async function recordEdit(session: SessionRuntime, id: string): Promise<void> {
  await session.store.append({
    turnId: 'turn-1', runId: 'turn-1-run',
    payload: {
      type: 'tool.completed', callId: `call-${id}`, toolName: 'apply_patch', callIndex: 0,
      status: 'ok', elapsedMs: 1, evidenceIds: [], result: patchResult(id),
    },
  });
}

test('/rewind 的 conversation 与 code 回退相互独立，并可跨重启恢复会话', async (context) => {
  const { root, session } = await setup(context);
  const oldItem = textMessage('old', 'user', '旧请求');
  const currentItem = textMessage('current', 'assistant', '新回答');
  await session.store.append({ payload: { type: 'checkpoint.saved', checkpoint: checkpoint(session.sessionId, 'turn-0', [oldItem], 0) } });
  const applied = await applyPatch(root, { version: 1, operations: [{ op: 'replace', path: 'version.txt', oldString: 'v0\n', newString: 'v1\n' }] });
  const editId = await saveEditCheckpoint(root, applied.checkpoint);
  await recordEdit(session, editId);
  await session.store.append({ payload: { type: 'checkpoint.saved', checkpoint: checkpoint(session.sessionId, 'turn-1', [oldItem, currentItem, patchResult(editId)], 1) } });

  const conversationOnly = await session.rewind(0, 'conversation');
  assert.equal(conversationOnly.restoredPaths.length, 0);
  assert.equal(await readFile(join(root, 'version.txt'), 'utf8'), 'v1\n');
  assert.deepEqual(session.conversation(), [oldItem]);

  const codeOnly = await session.rewind(0, 'code');
  assert.deepEqual(codeOnly.restoredPaths, ['version.txt']);
  assert.equal(await readFile(join(root, 'version.txt'), 'utf8'), 'v0\n');
  assert.deepEqual(session.conversation(), [oldItem]);

  await session.close();
  const reopened = await SessionRuntime.open({} as import('../../../../src/runtime/resumable-react-agent.js').ReactAgent, {
    rootDirectory: join(root, 'sessions'), workspaceRoot: root, sessionId: 'rewind-session',
  });
  context.after(() => reopened.close().catch(() => undefined));
  assert.deepEqual(reopened.conversation(), [oldItem]);
});

test('/rewind 的代码回退保留用户后续修改并返回明确跳过项', async (context) => {
  const { root, session } = await setup(context);
  await session.store.append({ payload: { type: 'checkpoint.saved', checkpoint: checkpoint(session.sessionId, 'turn-0', [], 0) } });
  const applied = await applyPatch(root, { version: 1, operations: [{ op: 'replace', path: 'version.txt', oldString: 'v0\n', newString: 'v1\n' }] });
  const editId = await saveEditCheckpoint(root, applied.checkpoint);
  await recordEdit(session, editId);
  await session.store.append({ payload: { type: 'checkpoint.saved', checkpoint: checkpoint(session.sessionId, 'turn-1', [patchResult(editId)], 1) } });
  await writeFile(join(root, 'version.txt'), 'user-edit\n');
  const result = await session.rewind(0, 'code');
  assert.deepEqual(result.restoredPaths, []);
  assert.deepEqual(result.skippedPaths, ['version.txt']);
  assert.equal(await readFile(join(root, 'version.txt'), 'utf8'), 'user-edit\n');
});

test('/rewind 拒绝运行中的 Turn 与非法索引', async (context) => {
  const { root, session } = await setup(context);
  await assert.rejects(session.rewind(0), /检查点索引无效/u);
  const hangingAgent = {
    executionPhase: () => 'auto',
    run: () => new Promise<never>(() => undefined),
    requestPause: () => undefined,
  } as unknown as import('../../../../src/runtime/resumable-react-agent.js').ReactAgent;
  const active = await SessionRuntime.open(hangingAgent, {
    rootDirectory: join(root, 'active-sessions'), workspaceRoot: root, sessionId: 'active-session',
  });
  context.after(() => active.close().catch(() => undefined));
  const runPromise = active.run('保持运行');
  await new Promise((resolve) => setTimeout(resolve, 0));
  await assert.rejects(active.rewind(0), /正在运行/u);
  await active.pause();
  void runPromise;
});
