import { lstat } from 'node:fs/promises';
import path from 'node:path';
import { PathPolicy, PathPolicyError } from '../../../src/runtime/path-policy.js';
import { parseManifest, type SkillManifest } from '../../../src/skills/skill-manager.js';

export type SkillEvalAssertion =
  | { id: string; type: 'file_exists'; path: string }
  | { id: string; type: 'file_contains'; path: string; text: string }
  | { id: string; type: 'manifest_valid'; name: string; descriptionIncludes: string };

export interface SkillEvalDefinition {
  schemaVersion: 1;
  skill: string;
  version: string;
  assertions: SkillEvalAssertion[];
}

export interface SkillEvalAssertionResult {
  id: string;
  passed: boolean;
  summary: string;
}

export interface SkillEvalReport {
  skill: string;
  version: string;
  passed: boolean;
  assertions: SkillEvalAssertionResult[];
}

/** 运行 Skill 自带的客观断言；不执行脚本、不调用模型、不把主观质量当作通过条件。 */
export async function runSkillEval(skillDirectory: string): Promise<SkillEvalReport> {
  const root = path.resolve(skillDirectory);
  const rootStat = await lstat(root).catch(() => undefined);
  if (!rootStat?.isDirectory() || rootStat.isSymbolicLink()) throw new Error('Skill 评测目录无效');
  const policy = await PathPolicy.create(root);
  const definition = parseDefinition((await policy.readTextFile('evals/evals.json', 256 * 1024)).content);
  if (definition.skill !== path.basename(root)) throw new Error('Skill 评测名称与目录不一致');
  const results: SkillEvalAssertionResult[] = [];
  for (const assertion of definition.assertions) results.push(await evaluateAssertion(policy, assertion, root));
  return { skill: definition.skill, version: definition.version, passed: results.every((item) => item.passed), assertions: results };
}

export function parseSkillEvalDefinition(value: unknown): SkillEvalDefinition {
  return parseDefinition(JSON.stringify(value));
}

function parseDefinition(text: string): SkillEvalDefinition {
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error('Skill evals.json 格式无效'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Skill evals.json 必须是对象');
  const item = value as Record<string, unknown>;
  if (item.schemaVersion !== 1 || typeof item.skill !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(item.skill)
    || typeof item.version !== 'string' || !Array.isArray(item.assertions) || item.assertions.length === 0 || item.assertions.length > 64) {
    throw new Error('Skill evals.json 顶层字段无效');
  }
  const ids = new Set<string>();
  const assertions = item.assertions.map((raw) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Skill eval 断言无效');
    const assertion = raw as Record<string, unknown>;
    if (typeof assertion.id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/u.test(assertion.id) || ids.has(assertion.id)) throw new Error('Skill eval 断言 id 无效或重复');
    ids.add(assertion.id);
    if (assertion.type === 'file_exists' && typeof assertion.path === 'string') return { id: assertion.id, type: 'file_exists', path: assertion.path } as const;
    if (assertion.type === 'file_contains' && typeof assertion.path === 'string' && typeof assertion.text === 'string') return { id: assertion.id, type: 'file_contains', path: assertion.path, text: assertion.text } as const;
    if (assertion.type === 'manifest_valid' && typeof assertion.name === 'string' && typeof assertion.descriptionIncludes === 'string') return { id: assertion.id, type: 'manifest_valid', name: assertion.name, descriptionIncludes: assertion.descriptionIncludes } as const;
    throw new Error(`Skill eval 断言类型不支持：${String(assertion.type)}`);
  });
  return { schemaVersion: 1, skill: item.skill, version: item.version, assertions };
}

async function evaluateAssertion(policy: PathPolicy, assertion: SkillEvalAssertion, root: string): Promise<SkillEvalAssertionResult> {
  try {
    if (assertion.type === 'file_exists') {
      const resolved = await policy.resolveExisting(assertion.path, 'file');
      return { id: assertion.id, passed: Boolean(resolved.canonicalPath), summary: `文件存在：${assertion.path}` };
    }
    if (assertion.type === 'file_contains') {
      const content = (await policy.readTextFile(assertion.path)).content;
      const passed = content.includes(assertion.text);
      return { id: assertion.id, passed, summary: passed ? `文件包含断言文本：${assertion.path}` : `文件缺少断言文本：${assertion.path}` };
    }
    const content = (await policy.readTextFile('SKILL.md')).content;
    const manifest: SkillManifest = parseManifest(content, path.basename(root), { strict: true });
    const passed = manifest.name === assertion.name && Boolean(manifest.description?.includes(assertion.descriptionIncludes));
    return { id: assertion.id, passed, summary: passed ? 'Skill frontmatter 断言通过' : 'Skill frontmatter 断言失败' };
  } catch (error) {
    const reason = error instanceof PathPolicyError ? error.code : error instanceof Error ? error.message : String(error);
    return { id: assertion.id, passed: false, summary: `断言执行失败：${reason}` };
  }
}
