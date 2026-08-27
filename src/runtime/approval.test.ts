import assert from 'node:assert/strict';
import test from 'node:test';
import { MemoryApprovalStore, PolicyEngine, createApprovalRequest } from './approval.js';

const request = createApprovalRequest({
  id: 'approval-1', sessionId: 'session-1', toolName: 'apply_patch', permission: 'workspace.write',
  arguments: { patch: { version: 1, operations: [{ op: 'create', path: 'a.txt', content: 'a' }] } },
  workspaceRoot: 'C:/repo', workspaceRevision: 'sha256:rev', reasonCode: 'approval_required', reason: '需要审批', createdAt: new Date().toISOString(),
});

test('Approval Store 支持 once 消费、session 隔离和持久化形状', async () => {
  const store = new MemoryApprovalStore();
  await store.save(request, { decision: 'allow', scope: 'once', decidedAt: new Date().toISOString() });
  assert.equal((await store.find(request))?.decision, 'allow');
  assert.equal(await store.find(request), undefined);
  await store.save(request, { decision: 'deny', scope: 'session', decidedAt: new Date().toISOString() });
  assert.equal((await store.find({ ...request, sessionId: 'other' }))?.decision, undefined);
  assert.equal((await store.find(request))?.decision, 'deny');
});

test('Policy Engine deny 优先于 allow，并对副作用默认要求审批', () => {
  const engine = new PolicyEngine([
    { id: 'allow-write', effect: 'allow', permission: 'workspace.write', explanation: '允许写入' },
    { id: 'deny-secret', effect: 'deny', pathPrefix: 'secrets/', explanation: '拒绝敏感目录' },
  ]);
  assert.equal(engine.evaluate({ toolName: 'apply_patch', permission: 'workspace.write', path: 'secrets/a.txt' }).decision, 'deny');
  assert.equal(engine.evaluate({ toolName: 'apply_patch', permission: 'workspace.write', path: 'src/a.ts' }).decision, 'allow');
  assert.equal(new PolicyEngine().evaluate({ toolName: 'run', permission: 'process.exec' }).decision, 'require_approval');
});
