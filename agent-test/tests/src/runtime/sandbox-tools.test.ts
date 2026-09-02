import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { SandboxAdapter, SandboxExecuteRequest } from '../../../../src/sandbox/index.js';
import { MemoryApprovalStore } from '../../../../src/runtime/approval.js';
import { registerSandboxTools } from '../../../../src/runtime/sandbox-tools.js';
import { ToolExecutor } from '../../../../src/runtime/tool-executor.js';
import { ToolRegistry } from '../../../../src/runtime/tool-registry.js';

class FakeSandbox implements SandboxAdapter {
  readonly capabilities = {
    adapter: 'fake', isolation: 'high', networkModes: ['none'] as const,
    resourceLimits: true, artifactCollection: false, hostExecution: false,
  } as const;
  readonly requests: SandboxExecuteRequest[] = [];
  async execute(request: SandboxExecuteRequest) {
    this.requests.push(request);
    return {
      status: 'passed' as const,
      exitCode: 0,
      stdout: 'sandbox output',
      stderr: '',
      durationMs: 4,
      outputTruncated: false,
      artifacts: [],
    };
  }
}

test('Sandbox 工具未审批时不执行，批准后只传递 executable 与 argv', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'echolens-sandbox-tool-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sandbox = new FakeSandbox();
  const registry = new ToolRegistry();
  registerSandboxTools(registry, sandbox);
  const context = {
    workspaceRoot: root,
    allowedPermissions: new Set(['process.exec'] as const),
    signal: new AbortController().signal,
  };

  // 未配置审批决策器时直接返回 approval_required，且 Sandbox 层零调用（deny-first）。
  const pending = await new ToolExecutor(registry).invoke('shell_exec', {
    executable: 'node', args: ['--version'], workspaceAccess: 'read-only',
  }, context);
  assert.equal(pending.error?.code, 'approval_required');
  assert.equal(sandbox.requests.length, 0);

  const approved = await new ToolExecutor(registry, {
    approvalStore: new MemoryApprovalStore(),
    approvalDecider: async () => ({ decision: 'allow', scope: 'once', decidedAt: new Date().toISOString() }),
  }).invoke('shell_exec', {
    executable: 'node', args: ['--version'], workspaceAccess: 'read-only',
  }, context);
  assert.equal(approved.status, 'ok');
  assert.equal(sandbox.requests.length, 1);
  assert.deepEqual(sandbox.requests[0]!.command, { executable: 'node', args: ['--version'] });
  assert.equal(sandbox.requests[0]!.network.mode, 'none');
});

test('run_tests 使用固定 npm argv，非法命令和 package_install 默认被拒绝', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'echolens-sandbox-test-tool-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'package.json'), JSON.stringify({ scripts: { typecheck: 'tsc --noEmit' } }), 'utf8');
  const sandbox = new FakeSandbox();
  const registry = new ToolRegistry();
  registerSandboxTools(registry, sandbox);
  const executor = new ToolExecutor(registry, {
    approvalDecider: async () => ({ decision: 'allow', scope: 'once', decidedAt: new Date().toISOString() }),
  });
  const context = {
    workspaceRoot: root,
    allowedPermissions: new Set(['process.exec'] as const),
    signal: new AbortController().signal,
  };

  const tested = await executor.invoke('run_tests', { script: 'test:unit', args: ['--test-name-pattern', 'safe'] }, context);
  assert.equal(tested.status, 'ok');
  assert.deepEqual(sandbox.requests[0]!.command, {
    executable: 'npm', args: ['run', 'test:unit', '--', '--test-name-pattern', 'safe'],
  });

  const verified = await executor.invoke('verify_changes', { changedFiles: ['src/example.ts'] }, context);
  assert.equal(verified.status, 'ok');
  assert.deepEqual(sandbox.requests[1]!.command, { executable: 'npm', args: ['run', 'typecheck'] });

  // 攻击样本：把 `cmd.exe /c whoami` 整串作为 executable 传入，
  // 试图用 shell 拼接绕过固定的 executable+argv 校验，必须被判为 invalid_arguments。
  const invalid = await executor.invoke('shell_exec', { executable: 'cmd.exe /c', args: ['whoami'] }, context);
  assert.equal(invalid.error?.code, 'invalid_arguments');
  // package_install 默认被拒绝（permission_denied），安装类副作用不会因为带有
  // allowedDomains 参数就被放行。
  const install = await executor.invoke('package_install', {
    packages: ['ajv'], allowedDomains: ['registry.npmjs.org'],
  }, context);
  assert.equal(install.error?.code, 'permission_denied');
  assert.equal(sandbox.requests.length, 2);
});
