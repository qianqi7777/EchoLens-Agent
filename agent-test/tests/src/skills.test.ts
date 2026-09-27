import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { SkillManager, parseManifest } from '../../../src/skills/skill-manager.js';
test('导入 Skill 包并解析 front matter', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'echolens-skill-')); context.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'my-skill'); await mkdir(source); await writeFile(join(source, 'SKILL.md'), '---\nname: my-skill\ndescription: review code when reviewing a pull request\n---\n# Rules\n'); await writeFile(join(source, 'extra.txt'), 'ok');
  const imported = await new SkillManager({ workspaceRoot: root }).import(source);
  assert.equal(imported.name, 'my-skill'); assert.equal(await readFile(join(root, '.echolens', 'skills', 'my-skill', 'extra.txt'), 'utf8'), 'ok');
});
test('Skill 导入拒绝缺少入口和超大入口', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'echolens-skill-')); context.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'bad'); await mkdir(source); await assert.rejects(() => new SkillManager({ workspaceRoot: root }).import(source), /SKILL.md/);
  await writeFile(join(source, 'SKILL.md'), 'x'.repeat(100)); await assert.rejects(() => new SkillManager({ workspaceRoot: root, maxBytes: 10 }).import(source), /大小限制/);
});
test('无 front matter 时使用目录名', () => assert.deepEqual(parseManifest('# hello', 'My Skill'), { name: 'my-skill', description: undefined }));
