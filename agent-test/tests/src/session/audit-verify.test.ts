import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { exportAuditLog, verifyAuditExport, verifyAuditLog } from '../../../../src/session/audit.js';
import { JsonlEventStore } from '../../../../src/session/jsonl-event-store.js';

test('审计校验能定位中间事件篡改并导出可离线校验包', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'echolens-audit-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const store = new JsonlEventStore(root, 'audit-session');
  await store.append({ payload: { type: 'session.created', workspaceRoot: root } });
  await store.append({ turnId: 'turn-1', payload: { type: 'turn.started', userMessage: 'test' } });
  await store.append({ payload: { type: 'run.completed', answer: 'ok', degraded: false } });
  await store.close();

  const valid = await verifyAuditLog(join(root, 'audit-session.jsonl'));
  assert.equal(valid.valid, true);
  assert.equal(valid.chainPresent, true);
  assert.equal(valid.eventCount, 3);

  const lines = (await readFile(join(root, 'audit-session.jsonl'), 'utf8')).trim().split('\n');
  const middle = JSON.parse(lines[1]!) as { payload: { type: string } };
  middle.payload.type = 'run.failed';
  lines[1] = JSON.stringify(middle);
  await writeFile(join(root, 'audit-session.jsonl'), `${lines.join('\n')}\n`);
  const tampered = await verifyAuditLog(join(root, 'audit-session.jsonl'));
  assert.equal(tampered.valid, false);
  assert.equal(tampered.failure?.line, 3);
  assert.equal(tampered.failure?.seq, 3);
  assert.match(tampered.failure?.eventId ?? '', /^[0-9a-f-]{36}$/u);

  await assert.rejects(() => exportAuditLog(join(root, 'audit-session.jsonl'), join(root, 'audit.json')));

  const cleanRoot = await mkdtemp(join(tmpdir(), 'echolens-audit-clean-'));
  context.after(() => rm(cleanRoot, { recursive: true, force: true }));
  const cleanStore = new JsonlEventStore(cleanRoot, 'clean-session');
  await cleanStore.append({ payload: { type: 'session.created', workspaceRoot: cleanRoot } });
  await cleanStore.append({ payload: { type: 'run.completed', answer: 'ok', degraded: false } });
  await cleanStore.close();
  const bundle = await exportAuditLog(join(cleanRoot, 'clean-session.jsonl'), join(cleanRoot, 'audit.json'));
  assert.equal(bundle.version, 1);
  assert.equal(verifyAuditExport(JSON.parse(await readFile(join(cleanRoot, 'audit.json'), 'utf8'))).valid, true);
});
