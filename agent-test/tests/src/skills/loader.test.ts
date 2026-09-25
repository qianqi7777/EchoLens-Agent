import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { SkillLoader } from '../../../../src/skills/loader.js';
import { SkillRuntime } from '../../../../src/skills/skill-runtime.js';
import { ToolRegistry } from '../../../../src/runtime/tool-registry.js';
import type { ToolSpec } from '../../../../src/runtime/types.js';

async function skill(root: string, name: string, description: string, extra = ''): Promise<string> {
  const directory = join(root, name);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n${extra}---\n# ${name}\n`);
  return directory;
}

function readTool(name: string, permission: ToolSpec['permission'] = 'workspace.read'): ToolSpec {
  return {
    name,
    description: name,
    permission,
    inputSchema: { type: 'object', additionalProperties: false },
    execute: async () => ({ status: 'ok', content: '', summary: '', evidenceIds: [] }),
  };
}

test('加载器校验 frontmatter、忽略未知字段并跳过非法条目', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'echolens-loader-')); context.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, '.echolens', 'skills'); const user = join(root, 'user-skills'); const builtin = join(root, 'builtin');
  await mkdir(project, { recursive: true }); await mkdir(user, { recursive: true }); await mkdir(builtin, { recursive: true });
  await skill(project, 'good-skill', 'search source when investigating a code question', 'future-field: ignored\n');
  await skill(project, 'bad--name', 'search source when investigating a code question');
  await writeFile(join(project, 'bad--name', 'SKILL.md'), '---\nname: bad--name\ndescription: search source when investigating a code question\n---\n');
  await skill(project, 'bad-name', 'search source when investigating a code question').then(async (directory) => {
    await writeFile(join(directory, 'SKILL.md'), '---\nname: other-name\ndescription: search source when investigating a code question\n---\n');
  });
  await mkdir(join(project, 'missing-description'), { recursive: true });
  await writeFile(join(project, 'missing-description', 'SKILL.md'), '---\nname: missing-description\n---\n');
  const result = await new SkillLoader({ workspaceRoot: root, userSkillRoot: user, builtinSkillRoot: builtin }).catalog();
  assert.deepEqual(result.entries.map((entry) => entry.name), ['good-skill']);
  assert.ok(result.warnings.some((warning) => warning.includes('bad-name')));
  assert.ok(result.warnings.some((warning) => warning.includes('bad--name')));
  assert.ok(result.warnings.some((warning) => warning.includes('missing-description')));
  const loaded = await new SkillLoader({ workspaceRoot: root, userSkillRoot: user, builtinSkillRoot: builtin }).load('good-skill');
  assert.match(loaded.body, /# good-skill/u);
});

test('发现优先级为 project > user > builtin，catalog 预算会截断', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'echolens-loader-')); context.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, '.echolens', 'skills'); const user = join(root, 'user-skills'); const builtin = join(root, 'builtin');
  await mkdir(project, { recursive: true }); await mkdir(user, { recursive: true }); await mkdir(builtin, { recursive: true });
  await skill(project, 'same-skill', 'search project files when working in this repository');
  await skill(user, 'same-skill', 'search user files when working in this repository');
  await skill(builtin, 'same-skill', 'search builtin files when working in this repository');
  await skill(builtin, 'other-skill', 'search source when investigating a code question');
  const loader = new SkillLoader({ workspaceRoot: root, userSkillRoot: user, builtinSkillRoot: builtin });
  const all = await loader.catalog({ maxTokens: 10_000 });
  assert.deepEqual(all.entries.map((entry) => entry.name), ['other-skill', 'same-skill']);
  assert.equal((await loader.load('same-skill')).body.includes('same-skill'), true);
  const bounded = await loader.catalog({ maxTokens: 12 });
  assert.equal(bounded.entries.length, 1);
  assert.ok(bounded.warnings.some((warning) => warning.includes('截断')));
});

test('allowed-tools 只能收缩已授权工具，references 读取受 PathPolicy 约束', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'echolens-loader-')); context.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, '.echolens', 'skills'); const user = join(root, 'user-skills'); const builtin = join(root, 'builtin');
  const directory = await skill(project, 'secure-skill', 'search source when investigating a code question', 'allowed-tools:\n - read_file\n - write_file\n - unknown_tool\n');
  await mkdir(join(directory, 'references'), { recursive: true }); await writeFile(join(directory, 'references', 'guide.md'), 'safe reference');
  await mkdir(user, { recursive: true }); await mkdir(builtin, { recursive: true });
  const registry = new ToolRegistry(); registry.register(readTool('read_file')); registry.register(readTool('write_file', 'workspace.write'));
  const loader = new SkillLoader({ workspaceRoot: root, userSkillRoot: user, builtinSkillRoot: builtin, toolRegistry: registry, allowedPermissions: new Set(['workspace.read']) });
  const result = await loader.catalog({ maxTokens: 10_000 });
  assert.deepEqual(result.entries[0]?.allowedTools, ['read_file']);
  assert.ok(result.warnings.some((warning) => warning.includes('未知工具')));
  assert.ok(result.warnings.some((warning) => warning.includes('权限未获授权')));
  const loaded = await loader.load('secure-skill');
  assert.equal(await loader.readReference(loaded, 'guide.md'), 'safe reference');
  assert.equal(await new SkillRuntime(loader).readReference(loaded, 'guide.md'), 'safe reference');
  await assert.rejects(() => loader.readReference(loaded, '../SKILL.md'), /路径无效/u);
});
