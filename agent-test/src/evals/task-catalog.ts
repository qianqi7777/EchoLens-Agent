import { readFile, stat } from 'node:fs/promises';
import { assertEvalTask } from './task-validation.js';
import type { EvalTaskDefinition } from './types.js';

/** Catalogs share storage, but each selected task retains its own fixture and grader. */
export async function readEvalTask(filePath: string, taskId?: string): Promise<EvalTaskDefinition> {
  const info = await stat(filePath);
  if (!info.isFile() || info.size > 5 * 1024 * 1024) throw new Error('Eval 任务文件无效或过大');
  const value: unknown = JSON.parse(await readFile(filePath, 'utf8'));
  if (taskId === undefined) {
    assertEvalTask(value);
    return value;
  }
  const catalog = value as { schemaVersion?: unknown; tasks?: unknown } | null;
  if (!catalog || catalog.schemaVersion !== 1 || !Array.isArray(catalog.tasks)
    || catalog.tasks.length < 1 || catalog.tasks.length > 500) throw new Error('Eval Task Catalog 无效');
  const ids = new Set<string>();
  let selected: EvalTaskDefinition | undefined;
  for (const task of catalog.tasks) {
    assertEvalTask(task);
    if (ids.has(task.id)) throw new Error(`Eval Catalog 重复任务 ID：${task.id}`);
    ids.add(task.id);
    if (task.id === taskId) selected = task;
  }
  if (!selected) throw new Error(`Eval Catalog 未找到任务：${taskId}`);
  return selected;
}
