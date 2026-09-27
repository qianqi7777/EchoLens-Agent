// Optional browser regression: requires Playwright and a running, externally-locked Lab server.
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.AGENT_TEST_PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.AGENT_TEST_URL || 'http://127.0.0.1:4317';
const health = await fetch(`${base}/api/health`).then((response) => response.json());
assert.equal(health.externalEnabled, false, 'Browser regression must not enable real CLIs');
const directory = path.resolve('.echolens/web-check');
await mkdir(directory, { recursive: true });
const browser = await chromium.launch({ headless: true, ...(process.env.AGENT_TEST_BROWSER_CHANNEL ? { channel: process.env.AGENT_TEST_BROWSER_CHANNEL } : {}) });
const errors = [];
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(base);
  await page.getByText('示例已加载', { exact: true }).waitFor();
  assert.ok(await page.locator('svg').count() >= 8);
  assert.equal(await page.locator('#execute').isDisabled(), true);
  const original = await page.locator('#issues').inputValue();
  await page.screenshot({ path: path.join(directory, 'desktop.png'), fullPage: true });
  await page.getByRole('button', { name: '运行对比', exact: true }).click();
  await page.getByText('模拟完成，未执行 CLI 或验证', { exact: true }).waitFor();
  assert.equal(await page.locator('#cards .card').count(), 1);
  assert.ok((await page.locator('#cards').innerText()).includes('不适用'));
  await page.locator('summary').click();
  assert.ok((await page.locator('#resultDetails').innerText()).includes('未启动 CLI'));
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出结果 JSON', exact: true }).click();
  const download = await downloadPromise;
  assert.ok(download.suggestedFilename().startsWith('comparison-'));
  await page.screenshot({ path: path.join(directory, 'results.png'), fullPage: true });
  await page.getByRole('tab', { name: '任务集', exact: true }).click();
  await page.locator('#issues').fill('{bad');
  assert.equal(await page.locator('#run').isDisabled(), true);
  await page.locator('#issues').fill(original);
  await page.locator('[data-provider="0"]').uncheck();
  assert.equal(await page.locator('#run').isDisabled(), true);
  await page.locator('[data-provider="0"]').check();

  // HTTP failure must not replace the editor with an error object.
  page.on('dialog', (dialog) => dialog.accept());
  await page.route('**/api/github/issues?**', (route) => route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"mock GitHub unavailable"}' }));
  await page.locator('#githubRepo').fill('owner/repo');
  await page.getByRole('button', { name: '读取', exact: true }).click();
  await page.getByText('mock GitHub unavailable', { exact: true }).waitFor();
  assert.equal(await page.locator('#issues').inputValue(), original);
  assert.equal(await page.locator('#run').isEnabled(), true);

  // No actual quality command is launched by this browser test.
  await page.route('**/api/quality', (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ passed: false, durationMs: 45, output: '<script>fixture</script>\nFAIL regression', truncated: true }) }));
  await page.getByRole('button', { name: '质量检查', exact: true }).click();
  await page.getByText('质量检查失败', { exact: true }).waitFor();
  assert.ok((await page.locator('#qualityOutput').innerText()).includes('<script>fixture</script>'));
  assert.ok((await page.locator('#qualityMeta').innerText()).includes('输出已截断'));
  await page.unroute('**/api/quality');
  await page.route('**/api/quality', (route) => new Promise((resolve) => setTimeout(resolve, 300)).then(() => route.abort()).catch(() => {}));
  await page.getByRole('button', { name: '质量检查', exact: true }).click();
  await page.locator('#cancel').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#run').isDisabled(), true);
  await page.locator('#cancel').click();
  await page.getByText('已取消', { exact: true }).waitFor();
  await page.locator('#cancel').waitFor({ state: 'hidden' });

  await page.getByRole('tab', { name: '任务集', exact: true }).click();
  const malicious = JSON.parse(original);
  malicious.issues[0].title = '<img src=x onerror="window.injected=true">';
  await page.locator('#file').setInputFiles({ name: 'tasks.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(malicious)) });
  await page.getByText('已导入 tasks.json', { exact: true }).waitFor();
  assert.equal(await page.locator('#issuePreview img').count(), 0);
  assert.equal(await page.evaluate(() => Boolean(window.injected)), false);
  await page.locator('#issues').fill(original);
  for (const [width, height] of [[390, 844], [768, 1024], [1440, 1000]]) {
    await page.setViewportSize({ width, height });
    await page.getByRole('tab', { name: '任务集', exact: true }).click();
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `Horizontal overflow at ${width}`);
    await page.screenshot({ path: path.join(directory, `viewport-${width}.png`), fullPage: true });
  }
  assert.deepEqual(errors, []);
  console.log('PASS: simulation, export/import, invalid JSON, empty providers, HTTP failure, safe logs, cancellation, injection, desktop/mobile layout');
  console.log(`Screenshots: ${directory}`);
} finally { await browser.close(); }
