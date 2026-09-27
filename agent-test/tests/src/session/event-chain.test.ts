import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventStoreCorruptionError, JsonlEventStore } from '../../../../src/session/jsonl-event-store.js';

test('Event Store 为新事件建立哈希链并可正常恢复', async () => {
  const root = await mkdtemp(join(tmpdir(), 'echolens-event-chain-'));
  const store = new JsonlEventStore(root, 'chain');
  await store.append({ payload: { type: 'session.created', workspaceRoot: root } });
  await store.append({ payload: { type: 'turn.started', userMessage: 'hello' } });
  await store.close();
  const lines = (await readFile(join(root, 'chain.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as { prevHash?: string });
  assert.equal(lines[0]!.prevHash, undefined);
  assert.match(lines[1]!.prevHash ?? '', /^[a-f0-9]{64}$/u);
  const reopened = new JsonlEventStore(root, 'chain');
  assert.equal((await reopened.read()).length, 2);
  await reopened.close();
});

test('Event Store 检测中间事件篡改造成的断链', async () => {
  const root = await mkdtemp(join(tmpdir(), 'echolens-event-chain-tamper-'));
  const store = new JsonlEventStore(root, 'chain');
  await store.append({ payload: { type: 'session.created', workspaceRoot: root } });
  await store.append({ payload: { type: 'turn.started', userMessage: 'hello' } });
  await store.close();
  const path = join(root, 'chain.jsonl');
  const lines = (await readFile(path, 'utf8')).trim().split('\n');
  const tampered = JSON.parse(lines[0]!) as { payload: { workspaceRoot: string } };
  tampered.payload.workspaceRoot = 'tampered';
  lines[0] = JSON.stringify(tampered);
  await writeFile(path, `${lines.join('\n')}\n`, 'utf8');
  await assert.rejects(() => new JsonlEventStore(root, 'chain').read(), (error: unknown) => error instanceof EventStoreCorruptionError);
});

test('Event Store 兼容升级前没有哈希字段的旧日志', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'echolens-event-chain-legacy-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'legacy.jsonl'), `${JSON.stringify({ version: 1, eventId: 'one', sessionId: 'legacy', seq: 1, timestamp: new Date().toISOString(), payload: { type: 'session.created', workspaceRoot: root } })}\n`, 'utf8');
  const store = new JsonlEventStore(root, 'legacy');
  assert.equal((await store.read()).length, 1);
  await store.close();
});
