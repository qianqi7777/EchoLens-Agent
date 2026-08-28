import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DockerSandboxAdapter } from './docker-sandbox.js';
import type { ProcessRunRequest, ProcessRunResult, ProcessRunner } from './process-runner.js';
import { SandboxError, type SandboxExecuteRequest } from './types.js';
import { FileSystemWorkspaceStager } from './workspace-stager.js';

class RecordingRunner implements ProcessRunner {
  readonly requests: ProcessRunRequest[] = [];
  constructor(private readonly results: ProcessRunResult[]) {}
  async run(request: ProcessRunRequest): Promise<ProcessRunResult> {
    this.requests.push(request);
    return this.results.shift() ?? result();
  }
}

test('Docker Sandbox 只挂载工作区并生成高隔离 argv', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'echolens-sandbox-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'src'));
  const runner = new RecordingRunner([result({ stdout: 'ok\n' })]);
  const sandbox = new DockerSandboxAdapter({ runner, image: 'echolens-test:local' });

  const executed = await sandbox.execute(request(root, { cwd: 'src' }));

  assert.equal(executed.status, 'passed');
  assert.equal(runner.requests.length, 1);
  const invocation = runner.requests[0]!;
  assert.equal(invocation.executable, 'docker');
  assert.equal(invocation.args[0], 'run');
  assert.ok(hasPair(invocation.args, '--pull', 'never'));
  assert.ok(hasPair(invocation.args, '--network', 'none'));
  assert.ok(invocation.args.includes('--read-only'));
  assert.ok(hasPair(invocation.args, '--cap-drop', 'ALL'));
  assert.ok(hasPair(invocation.args, '--security-opt', 'no-new-privileges:true'));
  assert.ok(hasPair(invocation.args, '--pids-limit', '128'));
  assert.ok(hasPair(invocation.args, '--memory', '1024m'));
  assert.ok(hasPair(invocation.args, '--cpus', '2'));
  assert.ok(hasPair(invocation.args, '--workdir', '/workspace/src'));
  const mount = invocation.args[invocation.args.indexOf('--mount') + 1];
  assert.match(mount ?? '', /[\\/]\.echolens[\\/]sandboxes[\\/]echolens-[a-f0-9-]{36}[\\/]workspace,dst=\/workspace,readonly$/u);
  assert.notEqual(mount, `type=bind,src=${root},dst=/workspace,readonly`);
  assert.deepEqual(invocation.args.slice(-3), ['echolens-test:local', 'node', '--version']);
  assert.equal(invocation.args.some((value) => value === '--privileged'), false);
});

test('Sandbox 暂存区排除 .env、私有目录和 Git 忽略文件', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'echolens-sandbox-stage-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'src'));
  await mkdir(join(root, 'studydocs'));
  await writeFile(join(root, 'src', 'index.ts'), 'export const safe = true;\n', 'utf8');
  await writeFile(join(root, '.env.local'), 'SECRET=opaque-value\n', 'utf8');
  await writeFile(join(root, 'studydocs', 'private.md'), 'private', 'utf8');
  const staged = await new FileSystemWorkspaceStager().prepare(root, 'echolens-00000000-0000-4000-8000-000000000000');
  t.after(() => staged.cleanup());

  assert.match(await readFile(join(staged.root, 'src', 'index.ts'), 'utf8'), /safe/u);
  await assert.rejects(readFile(join(staged.root, '.env.local'), 'utf8'));
  await assert.rejects(readFile(join(staged.root, 'studydocs', 'private.md'), 'utf8'));
});

test('Docker Sandbox 对网络、越界 cwd 和缺失 Docker 失败关闭', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'echolens-sandbox-deny-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runner = new RecordingRunner([result({ spawnError: 'ENOENT' })]);
  const sandbox = new DockerSandboxAdapter({ runner });

  await assert.rejects(sandbox.execute(request(root, {
    network: { mode: 'allowlist', allowedDomains: ['registry.npmjs.org'], allowedPorts: [443] },
  })), (error: unknown) => error instanceof SandboxError && error.code === 'sandbox_network_denied');
  await assert.rejects(sandbox.execute(request(root, { cwd: '..' })));
  await assert.rejects(sandbox.execute(request(root)), (error: unknown) => (
    error instanceof SandboxError && error.code === 'sandbox_unavailable'
  ));
});

test('Docker Sandbox 超时后按随机容器名执行强制清理', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'echolens-sandbox-timeout-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runner = new RecordingRunner([result({ timedOut: true }), result()]);
  const sandbox = new DockerSandboxAdapter({ runner });

  const executed = await sandbox.execute(request(root));

  assert.equal(executed.status, 'timeout');
  assert.equal(runner.requests.length, 2);
  const name = runner.requests[0]!.args[runner.requests[0]!.args.indexOf('--name') + 1];
  assert.deepEqual(runner.requests[1]!.args, ['rm', '--force', name]);
});

function request(root: string, overrides: Partial<SandboxExecuteRequest> = {}): SandboxExecuteRequest {
  return {
    kind: 'shell',
    command: { executable: 'node', args: ['--version'] },
    workspaceRoot: root,
    cwd: '.',
    workspaceAccess: 'read-only',
    network: { mode: 'none' },
    resources: { timeoutMs: 10_000, memoryMiB: 1024, cpuCount: 2, processLimit: 128, maxOutputBytes: 65_536 },
    ...overrides,
  };
}

function result(overrides: Partial<ProcessRunResult> = {}): ProcessRunResult {
  return {
    exitCode: 0,
    stdout: '',
    stderr: '',
    durationMs: 5,
    timedOut: false,
    cancelled: false,
    outputTruncated: false,
    ...overrides,
  };
}

function hasPair(values: readonly string[], key: string, value: string): boolean {
  const index = values.indexOf(key);
  return index >= 0 && values[index + 1] === value;
}
