import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { JsonGatewayTokenStore } from '../../../../src/credentials/gateway-token-store.js';
import { WindowsProtectedTokenStore } from '../../../../src/credentials/windows-protected-token-store.js';

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

test('JSON Token Store 原子保存、容错读取并支持幂等清理', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'echolens-json-token-store-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const store = new JsonGatewayTokenStore(join(root, 'nested', 'gateway-token.json'));
  const tokens = { accessToken: 'access', refreshToken: 'refresh', expiresAt: '2030-01-01T00:00:00.000Z', scope: ['models:read'] };

  assert.equal(await store.load(), undefined);
  await store.save(tokens);
  assert.deepEqual(await store.load(), tokens);
  await store.clear();
  await store.clear();
  assert.equal(await store.load(), undefined);

  await writeFile(store.filePath, JSON.stringify({ accessToken: 'only-access', scope: ['models:read'], refreshToken: 42 }));
  assert.deepEqual(await store.load(), { accessToken: 'only-access', scope: ['models:read'], refreshToken: undefined, expiresAt: undefined });
  await writeFile(store.filePath, JSON.stringify({ accessToken: 'bad', scope: ['models:read', 1] }));
  assert.equal(await store.load(), undefined);
  await writeFile(store.filePath, '{not-json');
  assert.equal(await store.load(), undefined);
});
