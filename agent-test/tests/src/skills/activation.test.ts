import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { SkillLoader } from '../../../../src/skills/loader.js';
import { SkillRuntime } from '../../../../src/skills/skill-runtime.js';

async function createSkill(root: string, name: string, description: string, options: { requires?: string[]; disabled?: boolean } = {}): Promise<void> {
  const directory = join(root, name);
  await mkdir(directory, { recursive: true });
  const requires = options.requires?.length ? `requires:\n${options.requires.map((item) => ` - ${item}`).join('\n')}\n` : '';
  await writeFile(join(directory, 'SKILL.md'), [
    '---', `name: ${name}`, `description: ${description}`, requires,
    options.disabled ? 'disable-model-invocation: true' : '', '---', `# ${name}`,
  ].join('\n'));
}

test('自动激活按描述命中，disabled Skill 只能手动调用', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'echolens-activation-')); context.after(() => rm(root, { recursive: true, force: true }));
  const skills = join(root, '.echolens', 'skills'); await mkdir(skills, { recursive: true });
  await createSkill(skills, 'search-helper', 'search source when investigating a code question');
  await createSkill(skills, 'manual-helper', 'run deployment when preparing a release', { disabled: true });
  const runtime = new SkillRuntime(new SkillLoader({ workspaceRoot: root, userSkillRoot: join(root, 'missing-user'), builtinSkillRoot: join(root, 'missing-builtin') }));
  const automatic = await runtime.activateForPrompt('Please search source for this code question');
  assert.deepEqual(automatic.skills.map((skill) => skill.name), ['search-helper']);
  assert.equal(automatic.prompt.includes('# search-helper'), true);
  assert.deepEqual((await runtime.activateForPrompt('run deployment when preparing a release')).skills, []);
  assert.equal((await runtime.activateBundle('manual-helper', { manual: true })).skills[0]?.name, 'manual-helper');
});

test('requires 只允许一层组合，递归和加载次数超限失败关闭', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'echolens-activation-')); context.after(() => rm(root, { recursive: true, force: true }));
  const skills = join(root, '.echolens', 'skills'); await mkdir(skills, { recursive: true });
  await createSkill(skills, 'base-helper', 'search source when investigating a code question');
  await createSkill(skills, 'main-helper', 'review code when investigating a code question', { requires: ['base-helper'] });
  const runtime = new SkillRuntime(new SkillLoader({ workspaceRoot: root, userSkillRoot: join(root, 'missing-user'), builtinSkillRoot: join(root, 'missing-builtin') }));
  assert.deepEqual((await runtime.activateBundle('main-helper')).skills.map((skill) => skill.name), ['main-helper', 'base-helper']);
  await createSkill(skills, 'recursive-a', 'search source when investigating a code question', { requires: ['recursive-b'] });
  await createSkill(skills, 'recursive-b', 'search source when investigating a code question', { requires: ['recursive-a'] });
  await assert.rejects(() => runtime.activateBundle('recursive-a'), /禁止递归/u);
  await assert.rejects(() => runtime.activateBundle('main-helper', { maxLoads: 1 }), /加载次数超过上限/u);
});
