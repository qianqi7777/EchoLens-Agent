import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyPatch } from '../../src/runtime/structured-patch.js';
import { DockerSandboxAdapter } from '../../src/sandbox/docker-sandbox.js';
import { NodeProcessRunner } from '../../src/sandbox/process-runner.js';
import type { SandboxExecuteRequest, SandboxExecuteResult } from '../../src/sandbox/types.js';

const executable = process.env.AGENT_DOCKER_EXECUTABLE?.trim() || 'docker';
const image = process.env.AGENT_SANDBOX_IMAGE?.trim() || 'node:22-bookworm-slim';
const proxyImage = process.env.AGENT_SANDBOX_PROXY_IMAGE?.trim() || image;
const runner = new NodeProcessRunner();
await requireDocker(runner, executable, image, proxyImage);

// 工作区建在宿主 OS 临时目录，挂载为容器内的 /workspace；容器内路径始终是 POSIX，宿主侧（Windows）使用盘符路径。
const root = await mkdtemp(join(tmpdir(), 'echolens-docker-smoke-'));
try {
  await writeFile(join(root, 'input.txt'), 'before\n');
  await writeFile(join(root, 'package.json'), '{"private":true}\n');
  const probe = await readFile(join(dirname(fileURLToPath(import.meta.url)), 'docker-network-probe.mjs'));
  await writeFile(join(root, 'network-probe.mjs'), probe);
  const sandbox = new DockerSandboxAdapter({ executable, image, proxyImage });

  // 只读工作区的信任边界：容器内对 /workspace 的写入必须失败，且宿主目录不得出现容器内生成的文件。
  const readOnly = await sandbox.execute(request(root, {
    command: {
      executable: 'node',
      args: ['-e', "require('node:fs').writeFileSync('/workspace/blocked.txt','x')"],
    },
  }));
  assert.equal(readOnly.status, 'failed', 'read-only workspace unexpectedly allowed a write');
  await assert.rejects(readFile(join(root, 'blocked.txt')));

  // network=none 必须拦截所有直接出网：对公网 IP 的 fetch 应因拒绝/超时而失败，失败即证明隔离生效。
  const isolated = await sandbox.execute(request(root, {
    command: {
      executable: 'node',
      args: ['-e', "fetch('http://1.1.1.1',{signal:AbortSignal.timeout(1500)}).then(()=>process.exit(1),()=>console.log('network blocked'))"],
    },
  }));
  assert.equal(isolated.status, 'passed', 'network=none did not block direct egress');

  // 容器内按批准路径写入的结果不直接落在挂载上，而是以 artifact bundle + structured patch 回归；
  // 宿主文件保持原样直到 applyPatch 在宿主侧合并，这是写回工作区前的可见校验边界。
  const generated = await sandbox.execute(request(root, {
    workspaceAccess: 'read-write',
    command: {
      executable: 'node',
      args: ['-e', "const f=require('node:fs');f.writeFileSync('input.txt','after\\n');f.writeFileSync('created.txt','artifact\\n')"],
    },
  }));
  assert.equal(generated.status, 'passed', details(generated));
  assert.ok(generated.artifactBundleId);
  assert.equal(generated.patch?.operations.length, 2);
  assert.equal(await readFile(join(root, 'input.txt'), 'utf8'), 'before\n');
  await applyPatch(root, generated.patch);
  assert.equal(await readFile(join(root, 'input.txt'), 'utf8'), 'after\n');
  assert.equal(await readFile(join(root, 'created.txt'), 'utf8'), 'artifact\n');

  // allowlist 只放行预置的 npm registry 域名；未列出的域名必须被代理拒绝，证明白名单生效。
  const allowed = await sandbox.execute(networkRequest(root, 'registry.npmjs.org', 'allow', '/npm'));
  assert.equal(allowed.status, 'passed', details(allowed));
  const denied = await sandbox.execute(networkRequest(root, 'example.com', 'deny', '/'));
  assert.equal(denied.status, 'passed', details(denied));

  console.log(JSON.stringify({
    docker: 'available',
    image,
    readOnlyWriteBlocked: true,
    directNetworkBlocked: true,
    artifactBundleId: generated.artifactBundleId,
    patchOperations: generated.patch?.operations.length ?? 0,
    allowedDomainConnected: true,
    unlistedDomainDenied: true,
  }, null, 2));
} finally {
  await rm(root, { recursive: true, force: true });
}

function request(root: string, overrides: Partial<SandboxExecuteRequest>): SandboxExecuteRequest {
  return {
    kind: 'shell',
    command: { executable: 'node', args: ['--version'] },
    workspaceRoot: root,
    cwd: '.',
    workspaceAccess: 'read-only',
    network: { mode: 'none' },
    resources: { timeoutMs: 30_000, memoryMiB: 512, cpuCount: 1, processLimit: 64, maxOutputBytes: 64 * 1024 },
    ...overrides,
  };
}

function networkRequest(root: string, hostname: string, expected: 'allow' | 'deny', path: string): SandboxExecuteRequest {
  return request(root, {
    kind: 'package_install',
    command: { executable: 'node', args: ['network-probe.mjs', hostname, expected, path] },
    network: { mode: 'allowlist', allowedDomains: ['registry.npmjs.org'], allowedPorts: [443] },
    resources: { timeoutMs: 60_000, memoryMiB: 512, cpuCount: 1, processLimit: 64, maxOutputBytes: 64 * 1024 },
  });
}

// 镜像必须已预先在本地准备，脚本不触发 image pull，避免把网络拉取失败混杂进沙箱隔离校验。
async function requireDocker(
  processRunner: NodeProcessRunner,
  docker: string,
  ...images: string[]
): Promise<void> {
  const info = await processRunner.run({
    executable: docker,
    args: ['info', '--format', '{{.ServerVersion}}'],
    timeoutMs: 15_000,
    maxOutputBytes: 8_192,
  });
  if (info.spawnError || info.exitCode !== 0) throw new Error('Docker Engine 不可用');
  for (const current of new Set(images)) {
    const inspect = await processRunner.run({
      executable: docker,
      args: ['image', 'inspect', current, '--format', '{{.Id}}'],
      timeoutMs: 15_000,
      maxOutputBytes: 8_192,
    });
    if (inspect.spawnError || inspect.exitCode !== 0) {
      throw new Error(`Docker 镜像未预先准备：${current}`);
    }
  }
}

function details(result: SandboxExecuteResult): string {
  return [result.stderr, result.stdout].filter(Boolean).join('\n').slice(-2_000);
}
