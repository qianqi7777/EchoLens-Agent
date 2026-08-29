import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { assertEvalTask } from './task-validation.js';
import type { EvalTaskDefinition, LeakageRisk } from './types.js';

export type EvalTemplateVariable =
  | { type: 'choice'; values: Array<string | number> }
  | { type: 'integer'; min: number; max: number };

export interface EvalTaskTemplate {
  schemaVersion: 1;
  id: string;
  version: string;
  introducedAt: string;
  leakageRisk: LeakageRisk;
  variables: Record<string, EvalTemplateVariable>;
  task: EvalTaskDefinition;
}

export interface EvalCatalogEntry {
  templateId: string;
  introducedAt: string;
  lastUsedAt?: string;
  leakageRisk: LeakageRisk;
  useCount: number;
  possibleLeak?: boolean;
}

export class DynamicTaskGenerator {
  generate(template: EvalTaskTemplate, seed: string | number): EvalTaskDefinition {
    assertTemplate(template);
    const random = seededRandom(String(seed));
    const variables: Record<string, string | number> = {};
    for (const [name, definition] of Object.entries(template.variables).sort(([left], [right]) => left.localeCompare(right))) {
      variables[name] = pickVariable(definition, random);
    }
    const task = interpolate(template.task, variables) as EvalTaskDefinition;
    const variant = createHash('sha256').update(`${template.id}:${seed}:${JSON.stringify(variables)}`).digest('hex').slice(0, 12);
    task.id = `${template.id}-${variant}`;
    task.version = template.version;
    task.introducedAt = template.introducedAt;
    task.leakageRisk = template.leakageRisk;
    task.generator = { templateId: template.id, seed: String(seed), variables };
    assertEvalTask(task);
    return task;
  }
}

export class EvalTaskCatalog {
  private writeQueue: Promise<unknown> = Promise.resolve();

  constructor(readonly filePath: string, private readonly now: () => Date = () => new Date()) {}

  async register(templates: readonly EvalTaskTemplate[]): Promise<void> {
    await this.serial(async () => {
      const entries = await this.readUnlocked();
      const byId = new Map(entries.map((entry) => [entry.templateId, entry]));
      for (const template of templates) {
        assertTemplate(template);
        const current = byId.get(template.id);
        byId.set(template.id, {
          templateId: template.id,
          introducedAt: template.introducedAt,
          leakageRisk: template.leakageRisk,
          useCount: current?.useCount ?? 0,
          lastUsedAt: current?.lastUsedAt,
          possibleLeak: current?.possibleLeak,
        });
      }
      await this.write([...byId.values()].sort((left, right) => left.templateId.localeCompare(right.templateId)));
    });
  }

  async select(templates: readonly EvalTaskTemplate[], count: number): Promise<EvalTaskTemplate[]> {
    if (!Number.isInteger(count) || count < 1) throw new Error('动态任务数量必须为正整数');
    for (const template of templates) assertTemplate(template);
    return this.serial(async () => {
      const entries = await this.readUnlocked();
      const byId = new Map(entries.map((entry) => [entry.templateId, entry]));
      const ranked = [...templates].sort((left, right) => compareCatalog(byId.get(left.id), byId.get(right.id), left, right));
      const selected = ranked.slice(0, Math.min(count, ranked.length));
      const usedAt = this.now().toISOString();
      for (const template of selected) {
        const current = byId.get(template.id);
        byId.set(template.id, {
          templateId: template.id,
          introducedAt: template.introducedAt,
          leakageRisk: template.leakageRisk,
          useCount: (current?.useCount ?? 0) + 1,
          lastUsedAt: usedAt,
          possibleLeak: current?.possibleLeak,
        });
      }
      await this.write([...byId.values()].sort((left, right) => left.templateId.localeCompare(right.templateId)));
      return selected;
    });
  }

  async markPossibleLeak(templateId: string, value = true): Promise<void> {
    await this.serial(async () => {
      const entries = await this.readUnlocked();
      const entry = entries.find((item) => item.templateId === templateId);
      if (!entry) throw new Error(`未知 Eval Template：${templateId}`);
      entry.possibleLeak = value;
      if (value && entry.leakageRisk !== 'known_leaked') entry.leakageRisk = 'high';
      await this.write(entries);
    });
  }

  async read(): Promise<EvalCatalogEntry[]> {
    await this.writeQueue;
    return this.readUnlocked();
  }

  private async serial<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.writeQueue.then(operation);
    this.writeQueue = next.catch(() => undefined);
    return next;
  }

  private async readUnlocked(): Promise<EvalCatalogEntry[]> {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, 'utf8')) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Eval Catalog 结构无效');
      const file = parsed as { version?: unknown; entries?: unknown };
      if (file.version !== 1 || !Array.isArray(file.entries) || !file.entries.every(isCatalogEntry)) {
        throw new Error('Eval Catalog 结构无效');
      }
      return file.entries;
    } catch (error) {
      if (error instanceof Error && (error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }

  private async write(entries: EvalCatalogEntry[]): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify({ version: 1, entries })}\n`, { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, this.filePath);
  }
}

function interpolate(value: unknown, variables: Record<string, string | number>): unknown {
  if (typeof value === 'string') {
    return value.replace(/\{\{([A-Za-z][A-Za-z0-9_]*)\}\}/gu, (_, name: string) => {
      if (!(name in variables)) throw new Error(`Eval Template 缺少变量：${name}`);
      return String(variables[name]);
    });
  }
  if (Array.isArray(value)) return value.map((item) => interpolate(item, variables));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, interpolate(item, variables)]));
  }
  return value;
}

function pickVariable(definition: EvalTemplateVariable, random: () => number): string | number {
  if (definition.type === 'choice') {
    if (definition.values.length === 0 || definition.values.length > 1_000) throw new Error('choice 变量值无效');
    return definition.values[Math.floor(random() * definition.values.length)]!;
  }
  if (!Number.isInteger(definition.min) || !Number.isInteger(definition.max) || definition.max < definition.min) {
    throw new Error('integer 变量范围无效');
  }
  return definition.min + Math.floor(random() * (definition.max - definition.min + 1));
}

function seededRandom(seed: string): () => number {
  let state = createHash('sha256').update(seed).digest().readUInt32LE(0) || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
}

function compareCatalog(
  left: EvalCatalogEntry | undefined,
  right: EvalCatalogEntry | undefined,
  leftTemplate: EvalTaskTemplate,
  rightTemplate: EvalTaskTemplate,
): number {
  const risk = (entry: EvalCatalogEntry | undefined, template: EvalTaskTemplate) => {
    if (entry?.possibleLeak || entry?.leakageRisk === 'known_leaked' || template.leakageRisk === 'known_leaked') return 3;
    return { low: 0, medium: 1, high: 2 }[entry?.leakageRisk ?? template.leakageRisk] ?? 3;
  };
  const leftUsed = left?.lastUsedAt ? Date.parse(left.lastUsedAt) : 0;
  const rightUsed = right?.lastUsedAt ? Date.parse(right.lastUsedAt) : 0;
  return risk(left, leftTemplate) - risk(right, rightTemplate)
    || leftUsed - rightUsed
    || (left?.useCount ?? 0) - (right?.useCount ?? 0)
    || leftTemplate.id.localeCompare(rightTemplate.id);
}

function assertTemplate(template: EvalTaskTemplate): void {
  if (template.schemaVersion !== 1 || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(template.id)
    || !/^[A-Za-z0-9][A-Za-z0-9.+_-]{0,63}$/u.test(template.version)
    || !template.variables || typeof template.variables !== 'object' || Array.isArray(template.variables) || !template.task) {
    throw new Error('Eval Template 无效');
  }
  if (!Number.isFinite(Date.parse(template.introducedAt))) throw new Error('Eval Template introducedAt 无效');
  if (!['low', 'medium', 'high', 'known_leaked'].includes(template.leakageRisk)) throw new Error('Eval Template leakageRisk 无效');
  const variables = Object.entries(template.variables);
  if (variables.length > 128) throw new Error('Eval Template 变量过多');
  for (const [name, definition] of variables) {
    if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/u.test(name)) throw new Error(`Eval Template 变量名无效：${name}`);
    pickVariable(definition, () => 0);
  }
}

function isCatalogEntry(value: unknown): value is EvalCatalogEntry {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Partial<EvalCatalogEntry>;
  return typeof entry.templateId === 'string' && typeof entry.introducedAt === 'string'
    && Number.isFinite(Date.parse(entry.introducedAt))
    && (entry.lastUsedAt === undefined || (typeof entry.lastUsedAt === 'string' && Number.isFinite(Date.parse(entry.lastUsedAt))))
    && typeof entry.leakageRisk === 'string' && ['low', 'medium', 'high', 'known_leaked'].includes(entry.leakageRisk)
    && Number.isInteger(entry.useCount) && (entry.useCount ?? -1) >= 0
    && (entry.possibleLeak === undefined || typeof entry.possibleLeak === 'boolean');
}
