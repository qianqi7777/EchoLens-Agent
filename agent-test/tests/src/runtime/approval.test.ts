import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { JsonApprovalStore, MemoryApprovalStore, PolicyEngine, createApprovalRequest } from '../../../../src/runtime/approval.js';

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
  // 安全不变量：同一请求同时命中 allow 与 deny 时 deny 必须无条件优先，
  // 否则可用宽 allow 条件或规则顺序绕过目录级拒绝，造成权限升级。
  assert.equal(engine.evaluate({ toolName: 'apply_patch', permission: 'workspace.write', path: 'secrets/a.txt' }).decision, 'deny');
  assert.equal(engine.evaluate({ toolName: 'apply_patch', permission: 'workspace.write', path: 'src/a.ts' }).decision, 'allow');
  assert.equal(new PolicyEngine().evaluate({ toolName: 'run', permission: 'process.exec' }).decision, 'require_approval');
});

test('持久化审批只保存参数哈希，不保存完整 Patch 或 Shell argv', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'echolens-approval-redaction-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'approvals.json');
  const store = new JsonApprovalStore(path);
  const shellRequest = createApprovalRequest({
    ...request,
    id: 'shell-approval',
    toolName: 'shell_exec',
    permission: 'process.exec',
    // 攻击样本：Shell argv 内为不应落盘的敏感值；验证持久化只写 argumentsHash，
    // 磁盘上的审批文件不得出现明文 argv 或完整 Patch 内容。
    arguments: { executable: 'tool', args: ['opaque-private-value'] },
  });
  await store.save(shellRequest, { decision: 'allow', scope: 'project', decidedAt: new Date().toISOString() });

  const persisted = await readFile(path, 'utf8');
  assert.doesNotMatch(persisted, /opaque-private-value/u);
  assert.match(persisted, /argumentsHash/u);
  assert.equal((await store.find(shellRequest))?.decision, 'allow');
});
