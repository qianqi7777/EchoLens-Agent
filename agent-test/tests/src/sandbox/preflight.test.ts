import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { ProcessRunRequest, ProcessRunResult, ProcessRunner } from '../../../../src/sandbox/process-runner.js';
import { prepareSandboxImages, runSandboxPreflight } from '../../../../src/sandbox/preflight.js';
import { ToolRegistry } from '../../../../src/runtime/tool-registry.js';
import { registerWorkspaceTools } from '../../../../src/runtime/workspace-tools.js';

function result(overrides: Partial<ProcessRunResult> = {}): ProcessRunResult {
  return {
    exitCode: 0, stdout: '', stderr: '', durationMs: 1, timedOut: false,
    cancelled: false, outputTruncated: false, ...overrides,
  };
}

class FakeRunner implements ProcessRunner {
  readonly requests: ProcessRunRequest[] = [];
  constructor(private readonly responses: ProcessRunResult[]) {}
  async run(request: ProcessRunRequest): Promise<ProcessRunResult> {
    this.requests.push(request);
    return this.responses.shift() ?? result();
  }
}

function healthyResponses(): ProcessRunResult[] {
  return [
    result({ stdout: 'Docker version 29.0.0' }),
    result({ stdout: '{"Version":"29.0.0"}' }),
    result({ stdout: '{"ServerVersion":"29.0.0"}' }),
    result({ stdout: 'default\n' }),
    result({ stdout: JSON.stringify({ Id: 'sha256:work', RepoDigests: [`node@sha256:abc`] }) }),
    result({ stdout: 'v22.0.0\n' }),
  ];
}

test('预检记录 Engine、context、镜像摘要并使用固定 argv', async () => {
  const runner = new FakeRunner(healthyResponses());
  const checked = await runSandboxPreflight({ runner, persist: false });
  assert.equal(checked.status, 'ready');
  assert.equal(checked.ok, true);
  assert.equal(checked.docker?.serverVersion, '29.0.0');
  assert.equal(checked.images[0]?.imageId, 'sha256:work');
  assert.deepEqual(runner.requests.at(-1)?.args, [
    'run', '--rm', '--pull', 'never', '--network', 'none', '--read-only', '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges:true', 'node:22-bookworm-slim', 'node', '--version',
  ]);
  assert.ok(runner.requests.every((request) => request.executable === 'docker'));
  assert.ok(runner.requests.every((request) => request.cwd === undefined));
});

test('预检区分 Docker CLI 缺失、Engine 不可用和镜像缺失', async () => {
  const missingCli = new FakeRunner([result({ spawnError: 'not found', exitCode: undefined })]);
  assert.equal((await runSandboxPreflight({ runner: missingCli, persist: false })).status, 'docker_cli_missing');

  const engine = new FakeRunner([
    result({ stdout: 'Docker version 29.0.0' }),
    result({ exitCode: 1, stderr: 'Cannot connect to the Docker daemon' }),
  ]);
  assert.equal((await runSandboxPreflight({ runner: engine, persist: false })).status, 'docker_engine_unavailable');

  const image = new FakeRunner([
    result({ stdout: 'Docker version 29.0.0' }), result({ stdout: '{"Version":"29"}' }),
    result({ stdout: '{"ServerVersion":"29"}' }), result({ stdout: 'default\n' }),
    result({ exitCode: 1, stderr: 'No such image: node:22-bookworm-slim' }),
  ]);
  assert.equal((await runSandboxPreflight({ runner: image, persist: false })).status, 'image_missing');
});

test('镜像准备遵循确认策略，pull 后必须重新 inspect 和 smoke test', async () => {
  const runner = new FakeRunner([
    ...healthyResponses().slice(0, 4),
    result({ exitCode: 1, stderr: 'No such image' }),
    result({ exitCode: 0, stdout: 'pulled' }),
    ...healthyResponses(),
  ]);
  const prepared = await prepareSandboxImages({ runner, autoPull: 'prompt', confirmPull: async () => true, persist: false });
  assert.equal(prepared.status, 'ready');
  assert.ok(runner.requests.some((request) => request.args[0] === 'pull'));
  // 默认 proxyImage 与工作镜像相同，预检按唯一引用检查；配置独立代理镜像时会再检查一项。
  assert.equal(runner.requests.filter((request) => request.args[0] === 'image').length, 2);
});

test('pull 被拒绝或失败时不伪造 ready', async () => {
  const missing = new FakeRunner([
    ...healthyResponses().slice(0, 4), result({ exitCode: 1, stderr: 'No such image' }),
  ]);
  const denied = await prepareSandboxImages({ runner: missing, autoPull: 'prompt', confirmPull: async () => false, persist: false });
  assert.equal(denied.status, 'image_missing');

  const failedPull = new FakeRunner([
    ...healthyResponses().slice(0, 4), result({ exitCode: 1, stderr: 'No such image' }),
    result({ exitCode: 1, stderr: 'network error' }),
  ]);
  const failed = await prepareSandboxImages({ runner: failedPull, autoPull: 'on', persist: false });
  assert.equal(failed.ok, false);
  assert.equal(failed.status, 'image_missing');
});

test('smoke test 失败时状态为 smoke_test_failed', async () => {
  const responses = healthyResponses();
  responses[responses.length - 1] = result({ exitCode: 1, stderr: 'node failed' });
  const checked = await runSandboxPreflight({ runner: new FakeRunner(responses), persist: false });
  assert.equal(checked.status, 'smoke_test_failed');
  assert.equal(checked.smokeTest?.ok, false);
});

test('预检证据写入私有诊断文件且不影响判定', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'echolens-preflight-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const checked = await runSandboxPreflight({
    projectRoot: root,
    runner: new FakeRunner([result({ spawnError: 'not found', exitCode: undefined })]),
  });
  const evidence = JSON.parse(await readFile(join(root, '.echolens', 'sandbox', 'preflight.json'), 'utf8')) as { status: string };
  assert.equal(checked.status, 'docker_cli_missing');
  assert.equal(evidence.status, 'docker_cli_missing');
});

test('只读工作区工具集不暴露 Patch 写工具', () => {
  const registry = new ToolRegistry();
  registerWorkspaceTools(registry, { readOnly: true });
  const names = registry.list().map((tool) => tool.name);
  assert.deepEqual(names.sort(), ['grep', 'list_files', 'read_file', 'workspace_search']);
});
