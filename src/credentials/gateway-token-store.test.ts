import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { WindowsProtectedTokenStore } from './windows-protected-token-store.js';

test('Windows DPAPI Token Store 保护令牌并支持清理', async (context) => {
  // DPAPI 保护只存在于 Windows，非 Windows 平台直接跳过该项 Windows 特有行为断言。
  if (process.platform !== 'win32') return;
  const root = await mkdtemp(join(tmpdir(), 'echolens-token-store-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const store = new WindowsProtectedTokenStore(join(root, 'gateway-token.dpapi'));
  await store.save({ accessToken: 'test-access', refreshToken: 'test-refresh', scope: ['models:read'] });
  const encrypted = await readFile(store.filePath, 'utf8');
  // 核心安全断言：即使磁盘文件被外部读取，也不能从中还原出明文令牌（文件内容是 DPAPI 密文）。
  assert.doesNotMatch(encrypted, /test-access|test-refresh/u);
  const loaded = await store.load();
  assert.equal(loaded?.accessToken, 'test-access');
  assert.equal(loaded?.refreshToken, 'test-refresh');
  assert.deepEqual(loaded?.scope, ['models:read']);
  await store.clear();
  assert.equal(await store.load(), undefined);
});
