import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { SandboxError, type SandboxAdapter, type SandboxExecuteRequest, type SandboxExecuteResult } from '../../../../src/sandbox/index.js';
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
  async execute(request: SandboxExecuteRequest): Promise<SandboxExecuteResult> {
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

test('verify_changes attaches structured failures while preserving the sandbox execution boundary', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'echolens-sandbox-failure-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'package.json'), JSON.stringify({ scripts: { typecheck: 'tsc --noEmit' } }), 'utf8');
  class FailingSandbox extends FakeSandbox {
    override async execute(request: SandboxExecuteRequest) {
      this.requests.push(request);
      return {
        status: 'failed' as const,
        exitCode: 1,
        stdout: 'FAIL src/math.test.ts\n  ● adds values\n\n    Expected: 3\n    Received: 4\n\n      at Object.<anonymous> (src/math.test.ts:12:5)\n',
        stderr: '', durationMs: 4, outputTruncated: false, artifacts: [],
      };
    }
  }
  const sandbox = new FailingSandbox();
  const registry = new ToolRegistry();
  registerSandboxTools(registry, sandbox);
  const result = await new ToolExecutor(registry, {
    approvalDecider: async () => ({ decision: 'allow', scope: 'once', decidedAt: new Date().toISOString() }),
  }).invoke('verify_changes', { changedFiles: ['src/example.ts'] }, {
    workspaceRoot: root,
    allowedPermissions: new Set(['process.exec'] as const),
    signal: new AbortController().signal,
  });
  assert.equal(result.status, 'failed');
  const data = result.data as { verification?: Array<{ failures?: Array<{ testName?: string; line?: number }> }> };
  assert.equal(data.verification?.[0]?.failures?.[0]?.testName, 'adds values');
  assert.equal(data.verification?.[0]?.failures?.[0]?.line, 12);
  assert.equal(sandbox.requests.length, 1);
  assert.equal(sandbox.requests[0]?.kind, 'test');

  class UnknownOutputSandbox extends FakeSandbox {
    override async execute(request: SandboxExecuteRequest) {
      this.requests.push(request);
      return {
        status: 'failed' as const, exitCode: 1,
        stdout: 'custom runner failed: api_key=sk-12345678', stderr: '',
        durationMs: 4, outputTruncated: false, artifacts: [],
      };
    }
  }
  const unknownSandbox = new UnknownOutputSandbox();
  const unknownRegistry = new ToolRegistry();
  registerSandboxTools(unknownRegistry, unknownSandbox);
  const unknown = await new ToolExecutor(unknownRegistry, {
    approvalDecider: async () => ({ decision: 'allow', scope: 'once', decidedAt: new Date().toISOString() }),
  }).invoke('verify_changes', { changedFiles: ['src/example.ts'] }, {
    workspaceRoot: root,
    allowedPermissions: new Set(['process.exec'] as const),
    signal: new AbortController().signal,
  });
  const unknownData = unknown.data as { verification?: Array<{ output?: string; failures?: unknown[] }> };
  assert.equal(unknownData.verification?.[0]?.output, 'custom runner failed: api_key=[REDACTED]');
  assert.equal(unknownData.verification?.[0]?.failures, undefined);
});

test('Sandbox tools preserve result states, artifact metadata, and network policy', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'echolens-sandbox-states-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'package.json'), JSON.stringify({ scripts: { test: 'node --test', build: 'node build.js' } }), 'utf8');

  class StateSandbox extends FakeSandbox {
    mode: 'passed' | 'timeout' | 'cancelled' | 'failed' = 'passed';
    override async execute(request: SandboxExecuteRequest): Promise<SandboxExecuteResult> {
      this.requests.push(request);
      if (request.kind === 'package_install') {
        return { status: 'passed', exitCode: 0, stdout: '', stderr: '', durationMs: 1, outputTruncated: false, artifacts: [] };
      }
      if (this.mode === 'passed') {
        return {
          status: 'passed', exitCode: 0, stdout: 'out', stderr: 'warn', durationMs: 2, outputTruncated: true,
          artifacts: [{ kind: 'workspace-change', path: 'dist/out.js', size: 4, sha256: 'abcd', change: 'added' }],
          artifactBundleId: 'bundle-1', warnings: ['limited'],
        };
      }
      return { status: this.mode, exitCode: this.mode === 'failed' ? 2 : undefined, stdout: '', stderr: '', durationMs: 3, outputTruncated: false, artifacts: [] };
    }
  }
  const sandbox = new StateSandbox();
  const registry = new ToolRegistry();
  registerSandboxTools(registry, sandbox, { defaultMemoryMiB: 256, defaultCpuCount: 1, defaultProcessLimit: 8, defaultMaxOutputBytes: 1024 });
  const executor = new ToolExecutor(registry, {
    approvalDecider: async () => ({ decision: 'allow', scope: 'once', decidedAt: new Date().toISOString() }),
  });
  const context = {
    workspaceRoot: root,
    allowedPermissions: new Set(['process.exec', 'network.request'] as const),
    signal: new AbortController().signal,
  };

  const passed = await executor.invoke('shell_exec', { executable: 'node', args: [], workspaceAccess: 'read-write', artifactPaths: ['dist/out.js'], timeoutMs: 100 }, context);
  assert.equal(passed.status, 'ok');
  assert.match(passed.content, /artifacts/u);
  assert.match(passed.content, /added: dist\/out\.js/u);
  assert.equal(sandbox.requests[0]?.network.mode, 'none');
  assert.equal(sandbox.requests[0]?.resources.memoryMiB, 256);
  assert.equal(sandbox.requests[0]?.workspaceAccess, 'read-write');

  sandbox.mode = 'timeout';
  const timedOut = await executor.invoke('run_build', {}, context);
  assert.equal(timedOut.status, 'timeout');
  assert.equal(timedOut.error?.code, 'timeout');
  sandbox.mode = 'cancelled';
  const cancelled = await executor.invoke('shell_exec', { executable: 'node' }, context);
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.error?.code, 'cancelled');
  sandbox.mode = 'failed';
  const failed = await executor.invoke('shell_exec', { executable: 'node' }, context);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.error?.code, 'command_failed');

  sandbox.mode = 'passed';
  const installed = await executor.invoke('package_install', {
    packages: ['ajv'], dev: true, allowedDomains: ['registry.npmjs.org'],
  }, context);
  assert.equal(installed.status, 'ok');
  const installRequest = sandbox.requests.at(-1);
  assert.deepEqual(installRequest?.command, { executable: 'npm', args: ['install', '--save-dev', 'ajv'] });
  assert.deepEqual(installRequest?.network, { mode: 'allowlist', allowedDomains: ['registry.npmjs.org'], allowedPorts: [443] });

  class ErrorSandbox extends StateSandbox {
    override async execute(request: SandboxExecuteRequest): Promise<SandboxExecuteResult> {
      this.requests.push(request);
      throw new SandboxError('sandbox_network_denied', 'network blocked');
    }
  }
  const networkBlocked = new ErrorSandbox();
  const networkRegistry = new ToolRegistry();
  registerSandboxTools(networkRegistry, networkBlocked);
  const blocked = await new ToolExecutor(networkRegistry, {
    approvalDecider: async () => ({ decision: 'allow', scope: 'once', decidedAt: new Date().toISOString() }),
  }).invoke('package_install', { packages: ['ajv'], allowedDomains: ['registry.npmjs.org'] }, context);
  assert.equal(blocked.status, 'denied');
  assert.equal(blocked.error?.code, 'sandbox_network_denied');
});
