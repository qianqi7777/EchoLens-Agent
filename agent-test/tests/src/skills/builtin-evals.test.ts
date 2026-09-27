import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { runSkillEval, parseSkillEvalDefinition } from '../../../src/evals/skill-runner.js';

const builtinRoot = join(dirname(fileURLToPath(import.meta.url)), '../../../../src/skills/builtin');

test('三个内置 Skill 的客观 evals 全部通过', async () => {
  for (const name of ['code-search', 'git-workflow', 'test-runner']) {
    const report = await runSkillEval(join(builtinRoot, name));
    assert.equal(report.passed, true, `${name}: ${JSON.stringify(report.assertions)}`);
    assert.equal(report.assertions.length, 3);
  }
});

test('Skill evals 拒绝重复 id、未知断言和越界断言数量', () => {
  assert.throws(() => parseSkillEvalDefinition({ schemaVersion: 1, skill: 'x', version: '1', assertions: [
    { id: 'same', type: 'file_exists', path: 'SKILL.md' }, { id: 'same', type: 'file_exists', path: 'SKILL.md' },
  ] }), /id 无效或重复/u);
  assert.throws(() => parseSkillEvalDefinition({ schemaVersion: 1, skill: 'x', version: '1', assertions: [{ id: 'x', type: 'subjective_quality' }] }), /类型不支持/u);
  assert.throws(() => parseSkillEvalDefinition({ schemaVersion: 1, skill: 'x', version: '1', assertions: Array.from({ length: 65 }, (_, index) => ({ id: `x-${index}`, type: 'file_exists', path: 'SKILL.md' })) }), /顶层字段无效/u);
});

test('Skill evals 路径越界失败关闭', async (context) => {
  const parent = await mkdtemp(join(tmpdir(), 'echolens-skill-eval-')); context.after(() => rm(parent, { recursive: true, force: true }));
  const root = join(parent, 'safe-skill');
  await mkdir(join(root, 'evals'), { recursive: true });
  await writeFile(join(root, 'SKILL.md'), '---\nname: safe-skill\ndescription: search files when investigating a code question\n---\n');
  await writeFile(join(root, 'evals', 'evals.json'), JSON.stringify({ schemaVersion: 1, skill: 'safe-skill', version: '1', assertions: [{ id: 'escape', type: 'file_exists', path: '../SKILL.md' }] }));
  const report = await runSkillEval(root);
  assert.equal(report.passed, false);
  assert.match(report.assertions[0]?.summary ?? '', /失败/u);
});
