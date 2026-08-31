import assert from 'node:assert/strict';
import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { EventStoreCorruptionError, JsonlEventStore } from './jsonl-event-store.js';

test('并行 append 由单写者分配连续 seq 且每行完整', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'echolens-events-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  let eventId = 0;
  const store = new JsonlEventStore(root, 'session-parallel', {
    eventId: () => `event-${eventId += 1}`,
    flushEachEvent: false,
  });

  // 10 个 append 并发发起且不加外部同步，验证单写者队列在乱序完成时仍分配连续 seq。
  const written = await Promise.all(Array.from({ length: 10 }, (_, callIndex) => store.append({
    turnId: 'turn-1',
    runId: 'run-1',
    payload: {
      type: 'tool.completed',
      callId: `call-${callIndex}`,
      toolName: 'read_file',
      callIndex,
      status: 'ok',
      elapsedMs: callIndex,
      evidenceIds: [],
    },
  })));
  await store.close();

  assert.deepEqual(written.map((event) => event.seq), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  const lines = (await readFile(join(root, 'session-parallel.jsonl'), 'utf8')).split('\n');
  assert.equal(lines.at(-1), '');
  assert.equal(lines.slice(0, -1).length, 10);
  assert.doesNotThrow(() => lines.slice(0, -1).forEach((line) => JSON.parse(line)));
});

test('恢复会移除损坏尾部并保留最后完整事件', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'echolens-events-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const first = new JsonlEventStore(root, 'session-tail', { flushEachEvent: false });
  await first.append({ payload: { type: 'session.created', workspaceRoot: 'D:\\repo' } });
  await first.close();
  // 手工追加不带换行结尾的截断行，模拟崩溃时最后一条事件只写了一半。
  await appendFile(join(root, 'session-tail.jsonl'), '{"version":1,"seq":2');

  const recovered = new JsonlEventStore(root, 'session-tail', { flushEachEvent: false });
  const event = await recovered.append({ payload: { type: 'run.started', model: 'test', resumed: true } });
  assert.equal(event.seq, 2);
  assert.equal((await recovered.read()).length, 2);
  await recovered.close();
});

test('中间损坏和 seq 缺口会失败关闭', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'echolens-events-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'session-corrupt.jsonl');
  // 故意构造损坏的行 JSON 并跳过 2 号 seq，验证读取端拒绝任何不连续日志而非静默忽略。
  await writeFile(path, [
    JSON.stringify(event(1)),
    '{broken}',
    JSON.stringify(event(3)),
    '',
  ].join('\n'));

  const store = new JsonlEventStore(root, 'session-corrupt', { flushEachEvent: false });
  await assert.rejects(store.read(), EventStoreCorruptionError);
});

test('支持 afterSeq、Session 列表并在写入前脱敏', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'echolens-events-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const store = new JsonlEventStore(root, 'session-query', { flushEachEvent: false });
  await store.append({ payload: { type: 'session.created', workspaceRoot: 'D:\\repo' } });
  // 敏感样本：明文模拟 Authorization 头，验证脱敏在持久化前生效。
  await store.append({ payload: { type: 'turn.started', userMessage: 'Authorization: Bearer secret-value' } });

  const events = await store.read(1);
  assert.equal(events.length, 1);
  assert.doesNotMatch(JSON.stringify(events), /secret-value/u);
  await store.close();
  assert.deepEqual((await JsonlEventStore.list(root)).map((item) => item.sessionId), ['session-query']);
});

function event(seq: number) {
  return {
    version: 1,
    eventId: `event-${seq}`,
    sessionId: 'session-corrupt',
    seq,
    timestamp: '2026-08-25T00:00:00.000Z',
    payload: { type: 'session.created', workspaceRoot: 'D:\\repo' },
  };
}
