import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { PluginManager } from '../../../../src/plugins/plugin-manager.js';

test('插件导出与导入只包含公开组件', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'echolens-plugin-'));
  const source = await mkdtemp(join(tmpdir(), 'echolens-plugin-source-'));
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(source, { recursive: true, force: true })]));
  await mkdir(join(root, '.echolens', 'skills', 'demo'), { recursive: true });
  await writeFile(join(root, '.echolens', 'skills', 'demo', 'SKILL.md'), '---\nname: demo\ndescription: search files when reviewing code\n---\n');
  await writeFile(join(root, '.echolens', 'mcp.json'), '{"version":1,"servers":[]}');
  const manager = new PluginManager(root);
  const exported = await manager.exportBundle('demo-plugin');
  assert.deepEqual(exported.components, ['skills', 'mcp']);
  const imported = await new PluginManager(source).importBundle(exported.path);
  assert.equal(imported.name, 'demo-plugin');
  assert.match(await readFile(join(source, '.echolens', 'plugins', 'demo-plugin', 'plugin.json'), 'utf8'), /demo-plugin/u);
});

test('插件拒绝受限文件与符号链接', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'echolens-plugin-host-'));
  const bundle = join(await mkdtemp(join(tmpdir(), 'echolens-plugin-parent-')), 'unsafe-plugin');
  await mkdir(bundle, { recursive: true });
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(bundle, { recursive: true, force: true })]));
  await writeFile(join(bundle, 'plugin.json'), JSON.stringify({ version: 1, name: basename(bundle), components: [] }));
  await writeFile(join(bundle, '.env'), 'TOKEN=secret');
  await assert.rejects(() => new PluginManager(root).importBundle(bundle), /受限路径/u);
});
