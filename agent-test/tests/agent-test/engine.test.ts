import assert from 'node:assert/strict';
import test from 'node:test';
import { runComparison } from '../../src/engine.js';

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
