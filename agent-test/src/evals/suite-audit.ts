import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { DynamicTaskGenerator, type EvalTaskTemplate } from './dynamic-task.js';
import { assertEvalTask } from './task-validation.js';
import type { EvalTaskDefinition } from './types.js';

export const EVAL_FIXTURE_ROOT = path.resolve('agent-test/fixtures/evals');

export interface EvalSuiteManifest {
  schemaVersion: 1;
  id: string;
  version: string;
  entries: Array<{
    task?: string;
    template?: string;
    seed?: string;
    candidate: string;
  }>;
}

export interface EvalSuiteTaskAudit {
  taskId: string;
  taskVersion: string;
  kind: EvalTaskDefinition['kind'];
  domain?: EvalTaskDefinition['domain'];
  difficulty?: EvalTaskDefinition['difficulty'];
  source?: EvalTaskDefinition['source'];
  split?: EvalTaskDefinition['split'];
  fingerprint: string;
}

export interface EvalSuiteAudit {
  passed: boolean;
  suiteId: string;
  suiteVersion: string;
  entries: number;
  uniqueTaskIds: number;
  duplicateTaskIds: string[];
  duplicateFingerprints: string[];
  versionMismatches: string[];
  metadataMissing: string[];
  tasks: EvalSuiteTaskAudit[];
}

export async function auditEvalSuite(suiteId: string): Promise<EvalSuiteAudit> {
  const manifest = await readSuiteManifest(suiteId);
  const tasks: EvalSuiteTaskAudit[] = [];
  const ids = new Map<string, number>();
  const fingerprints = new Map<string, number>();
  const versionMismatches: string[] = [];
  const metadataMissing: string[] = [];

  for (const entry of manifest.entries) {
    const task = await loadTask(entry);
    if (task.version !== manifest.version) versionMismatches.push(`${task.id}@${task.version}`);
    const missing = ['domain', 'difficulty', 'source', 'split']
      .filter((field) => task[field as keyof EvalTaskDefinition] === undefined);
    metadataMissing.push(...missing.map((field) => `${task.id}:${field}`));
    const fingerprint = fingerprintTask(task);
    tasks.push({
      taskId: task.id,
      taskVersion: task.version,
      kind: task.kind,
      domain: task.domain,
      difficulty: task.difficulty,
      source: task.source,
      split: task.split,
      fingerprint,
    });
    ids.set(task.id, (ids.get(task.id) ?? 0) + 1);
    fingerprints.set(fingerprint, (fingerprints.get(fingerprint) ?? 0) + 1);
  }

  const duplicateTaskIds = [...ids.entries()].filter(([, count]) => count > 1).map(([id]) => id);
  const duplicateFingerprints = [...fingerprints.entries()].filter(([, count]) => count > 1).map(([fingerprint]) => fingerprint);
  return {
    passed: duplicateTaskIds.length === 0 && duplicateFingerprints.length === 0
      && versionMismatches.length === 0 && metadataMissing.length === 0,
    suiteId: manifest.id,
    suiteVersion: manifest.version,
    entries: manifest.entries.length,
    uniqueTaskIds: ids.size,
    duplicateTaskIds,
    duplicateFingerprints,
    versionMismatches,
    metadataMissing,
    tasks,
  };
}

export async function readSuiteManifest(suiteId: string): Promise<EvalSuiteManifest> {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/u.test(suiteId)) throw new Error('Suite 名称无效');
  const manifest = await readJson<Partial<EvalSuiteManifest>>(path.join(EVAL_FIXTURE_ROOT, 'suites', `${suiteId}.suite.json`));
  if (manifest.schemaVersion !== 1 || manifest.id !== suiteId
    || typeof manifest.version !== 'string' || !manifest.version
    || !Array.isArray(manifest.entries) || manifest.entries.length < 1 || manifest.entries.length > 500
    || manifest.entries.some((entry) => !entry || typeof entry !== 'object' || Array.isArray(entry)
      || typeof entry.candidate !== 'string' || Boolean(entry.task) === Boolean(entry.template))) {
    throw new Error(`Eval Suite 清单无效：${suiteId}`);
  }
  return manifest as EvalSuiteManifest;
}

export function resolveEvalFixture(relative: string): string {
  if (typeof relative !== 'string' || relative.length > 512 || path.isAbsolute(relative)
    || relative.split(/[\\/]/u).some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new Error('Suite fixture 路径必须是干净的相对路径');
  }
  const resolved = path.resolve(EVAL_FIXTURE_ROOT, relative);
  const rel = path.relative(EVAL_FIXTURE_ROOT, resolved);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('Suite fixture 路径越界');
  return resolved;
}

async function loadTask(entry: EvalSuiteManifest['entries'][number]): Promise<EvalTaskDefinition> {
  const taskPath = entry.task ? resolveEvalFixture(entry.task) : undefined;
  const templatePath = entry.template ? resolveEvalFixture(entry.template) : undefined;
  if (Boolean(taskPath) === Boolean(templatePath)) throw new Error('Suite 每项必须且只能引用静态任务或动态模板');
  if (templatePath && typeof entry.seed !== 'string') throw new Error('Suite 动态任务必须固定 seed');
  if (taskPath && entry.seed !== undefined) throw new Error('静态任务不得声明 seed');
  if (!entry.candidate) throw new Error('Suite 每项必须引用 Candidate');
  if (taskPath) {
    const task = await readJson<EvalTaskDefinition>(taskPath);
    assertEvalTask(task);
    return task;
  }
  const template = await readJson<EvalTaskTemplate>(templatePath!);
  return new DynamicTaskGenerator().generate(template, entry.seed!);
}

function fingerprintTask(task: EvalTaskDefinition): string {
  const clone = structuredClone(task) as Partial<EvalTaskDefinition>;
  delete clone.id;
  delete clone.version;
  delete clone.generator;
  return stableJson(clone);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(',')}]`;
  if (!value || typeof value !== 'object') return JSON.stringify(value) ?? 'undefined';
  return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(',')}}`;
}

async function readJson<T>(filePath: string): Promise<T> {
  const info = await stat(filePath);
  if (!info.isFile() || info.size > 5 * 1024 * 1024) throw new Error(`Eval 文件无效或过大：${filePath}`);
  return JSON.parse(await readFile(filePath, 'utf8')) as T;
}
