import assert from 'node:assert/strict';
import test from 'node:test';
import { runComparison } from '../../src/engine.js';
import { createLabServer } from '../../src/server.js';
import { validateIssueSet } from '../../src/validation.js';
import { runLabProcess } from '../../src/process.js';
import { loadGithubIssues } from '../../src/github.js';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import type { AddressInfo } from 'node:net';
import { get } from 'node:http';

const sample = { repo: 'local/test', issues: [{ id: 'test', title: 'fix a bug', checks: [] }] };

test('Issue 校验拒绝空集、重复、错误类型和越界 Check cwd', () => {
  for (const value of [null, {}, { ...sample, issues: [] }, { ...sample, issues: [...sample.issues, ...sample.issues] },
    { ...sample, issues: [{ id: '../escape', title: 'bad' }] },
    { ...sample, issues: [{ id: 'one', title: 1 }] },
    { ...sample, issues: [{ id: 'one', title: 'test', checks: [{ id: 'c', command: { executable: 'node', args: [] }, cwd: '../outside' }] }] },
    { ...sample, issues: [{ id: 'one', title: 'test', checks: [{ id: 'c', command: { executable: 'node', args: [] }, timeoutMs: -1 }] }] },
  ]) assert.throws(() => validateIssueSet(value));
  assert.doesNotThrow(() => validateIssueSet(sample));
});

test('Lab HTTP 校验来源、请求大小、并发、GitHub 失败及取消', async (t) => {
  let calls = 0;
  let aborted = false;
  const server = createLabServer({ externalEnabled: false,
    compare: async () => { calls++; return []; },
    github: async () => { throw new Error('mock GitHub 503'); },
    quality: async (signal) => {
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => { aborted = true; resolve(); }, { once: true }));
      return { passed: false, output: 'cancelled', durationMs: 1 };
    },
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const payload = { issueSet: sample, providers: [{ id: 'local-sim', enabled: true }], repoRoot: '.', execute: false };
  const headers = { 'content-type': 'application/json', 'x-agent-test-request': '1' };
  const post = (body: unknown, extra = {}) => fetch(`${base}/api/compare`, { method: 'POST', headers: { ...headers, ...extra }, body: JSON.stringify(body) });
  assert.equal((await fetch(`${base}/api/health`).then((r) => r.json()) as { externalEnabled: boolean }).externalEnabled, false);
  assert.equal((await post(payload)).status, 200);
  assert.equal(calls, 1);
  assert.equal((await post({ ...payload, execute: true, confirmExternal: true })).status, 403);
  assert.equal((await post(payload, { origin: 'http://evil.invalid' })).status, 403);
  const badHostStatus = await new Promise<number | undefined>((resolve, reject) => {
    get(`${base}/api/health`, { headers: { host: 'evil.invalid' } }, (response) => {
      response.resume(); resolve(response.statusCode);
    }).on('error', reject);
  });
  assert.equal(badHostStatus, 403);
  assert.equal((await post(payload, { 'x-agent-test-request': '' })).status, 403);
  assert.equal((await post({ ...payload, providers: [{ id: 'unknown', enabled: true }] })).status, 400);
  assert.equal((await post({ ...payload, providers: [{ id: 'local-sim', enabled: false }] })).status, 400);
  assert.equal((await post({ ...payload, extra: 'x'.repeat(2_000_001) })).status, 413);
  assert.equal((await fetch(`${base}/api/github/issues?repo=a/b`)).status, 400);
  assert.equal((await fetch(`${base}/.env.local`)).status, 404);
  assert.equal((await fetch(`${base}/`, { method: 'POST' })).status, 405);
  assert.equal(calls, 1);
  const controller = new AbortController();
  const pending = fetch(`${base}/api/quality`, { method: 'POST', headers, body: '{}', signal: controller.signal }).catch(() => undefined);
  for (let i = 0; i < 50; i++) {
    const health = await fetch(`${base}/api/health`).then((r) => r.json()) as { active: unknown };
    if (health.active) break;
    await delay(10);
  }
  assert.equal((await post(payload)).status, 409);
  controller.abort(); await pending;
  for (let i = 0; i < 100 && !aborted; i++) await delay(10);
  assert.equal(aborted, true);
  assert.equal((await post(payload)).status, 200);
});

test('Lab 仓库真实路径校验拒绝指向允许根目录外的 Junction', async (t) => {
  const temp = await mkdtemp(path.join(tmpdir(), 'echolens-lab-boundary-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const root = path.join(temp, 'root'); const outside = path.join(temp, 'outside');
  await mkdir(root); await mkdir(outside);
  await symlink(outside, path.join(root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  let calls = 0;
  const server = createLabServer({ repoRoot: root, compare: async () => { calls++; return []; } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/compare`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-agent-test-request': '1' },
    body: JSON.stringify({ issueSet: sample, providers: [{ id: 'local-sim', enabled: true }], repoRoot: 'escape' }),
  });
  assert.equal(response.status, 400); assert.equal(calls, 0);
});

test('Lab 子进程限制输出、脱敏，并支持超时和取消', async () => {
  const output = await runLabProcess(process.execPath, ['-e', 'console.log("api_key=placeholder-value"); process.stdout.write("x".repeat(100000));'], process.cwd(), 3000);
  assert.equal(output.truncated, true); assert.doesNotMatch(output.stdout, /placeholder-value/u);
  const timeout = await runLabProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)'], process.cwd(), 100);
  assert.equal(timeout.timedOut, true);
  const controller = new AbortController();
  const running = runLabProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)'], process.cwd(), 3000, controller.signal);
  controller.abort(); assert.equal((await running).cancelled, true);
  await assert.rejects(async () => runLabProcess(process.execPath, [], process.cwd(), 100, controller.signal));
});

test('GitHub 参数在联网前校验', async () => {
  for (const repo of ['a/b?token=x', 'a/b/c', 'https://example.invalid']) await assert.rejects(loadGithubIssues(repo), /格式/u);
  for (const limit of [NaN, 0, 101, 1.5]) await assert.rejects(loadGithubIssues('owner/repo', limit), /数量/u);
});

test('真实命令替身报告失败 Check 并排除嵌套私有文件', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'echolens-lab-fixture-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'nested', 'studydoc'), { recursive: true });
  await writeFile(path.join(root, 'nested', 'studydoc', 'private.txt'), 'fixture');
  await writeFile(path.join(root, 'greet.cjs'), 'module.exports = () => "Hello!";');
  const previous = process.env.AGENT_TEST_ENABLE_EXTERNAL;
  process.env.AGENT_TEST_ENABLE_EXTERNAL = 'true';
  try {
    const [summary] = await runComparison({ repo: 'fixture', issues: [{ id: 'test', title: 'fix', checks: [
      { id: 'meaningful', command: { executable: process.execPath, args: ['-e', 'require("node:assert/strict").equal(require("./greet.cjs")(), "Hello, Ada!")'] } },
    ] }] }, [{ id: 'echolens', label: 'Mock only', command: process.execPath,
      args: ['-e', 'if(require("node:fs").existsSync("nested/studydoc/private.txt")) process.exit(2); console.log("{}")'] }], root, true);
    assert.equal(summary?.results[0]?.exitCode, 0);
    assert.equal(summary?.results[0]?.verification, 'failed');
    assert.equal(summary?.results[0]?.checks?.[0]?.passed, false);
    assert.equal(summary?.resolvedBugs, 0);
    assert.equal(await readFile(path.join(root, 'greet.cjs'), 'utf8'), 'module.exports = () => "Hello!";');
  } finally {
    if (previous === undefined) delete process.env.AGENT_TEST_ENABLE_EXTERNAL;
    else process.env.AGENT_TEST_ENABLE_EXTERNAL = previous;
  }
});

test('本地模拟 Provider 汇总 Issue 发现数、解决数和耗时', async () => {
  const result = await runComparison({
    repo: 'local/test',
    issues: [
      { id: 'one', title: '修复一个 bug', checks: [{ id: 'ok', command: { executable: 'node', args: [] } }] },
      { id: 'two', title: '更新文档', checks: [] },
    ],
  }, [{ id: 'local-sim', label: '本地模拟' }], process.cwd());

  assert.equal(result[0]?.foundBugs, 1);
  assert.equal(result[0]?.resolvedBugs, 0);
  assert.equal(result[0]?.resolutionRate, 0);
  assert.equal(result[0]?.results[0]?.mode, 'simulated');
});

test('真实执行只在隔离副本和验证命令都通过时计为已解决', async () => {
  const previous = process.env.AGENT_TEST_ENABLE_EXTERNAL;
  process.env.AGENT_TEST_ENABLE_EXTERNAL = 'true';
  try {
    const result = await runComparison({
      repo: 'local/test',
      issues: [{ id: 'one', title: 'issue', checks: [{ id: 'ok', command: { executable: process.execPath, args: ['-e', 'process.exit(0)'] } }] }],
    }, [{
      id: 'codex', label: '本地命令替身', command: process.execPath,
      args: ['-e', 'process.stdout.write(JSON.stringify({foundBugs: 1}))'],
    }], process.cwd(), true);
    assert.equal(result[0]?.resolvedBugs, 1);
    assert.equal(result[0]?.results[0]?.mode, 'executed');
  } finally {
    if (previous === undefined) delete process.env.AGENT_TEST_ENABLE_EXTERNAL;
    else process.env.AGENT_TEST_ENABLE_EXTERNAL = previous;
  }
});

test('未显式启用外部执行时拒绝启动真实 CLI', async () => {
  const previous = process.env.AGENT_TEST_ENABLE_EXTERNAL;
  delete process.env.AGENT_TEST_ENABLE_EXTERNAL;
  try {
    await assert.rejects(
      runComparison(
        { repo: 'local/test', issues: [{ id: 'one', title: 'issue' }] },
        [{ id: 'codex', label: 'Codex', command: 'codex', enabled: true }],
        process.cwd(),
        true,
      ),
      /真实 CLI 执行已锁定/u,
    );
  } finally {
    if (previous === undefined) delete process.env.AGENT_TEST_ENABLE_EXTERNAL;
    else process.env.AGENT_TEST_ENABLE_EXTERNAL = previous;
  }
});
