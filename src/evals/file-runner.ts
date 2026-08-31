import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { DockerSandboxAdapter } from '../sandbox/docker-sandbox.js';
import { DynamicTaskGenerator, type EvalTaskTemplate } from './dynamic-task.js';
import { EvalHarness } from './harness.js';
import { calculateRunMetrics, type EvalRunMetrics } from './metrics.js';
import { EvalResultStore } from './result-store.js';
import type {
  EvalCandidateResult,
  EvalCandidateRunner,
  EvalRunRecord,
  EvalTaskDefinition,
} from './types.js';

export interface EvalFileRunOptions {
  taskPath?: string;
  templatePath?: string;
  seed?: string;
  candidatePath: string;
  resultPath: string;
  suiteId?: string;
  retainFailedWorkspace?: boolean;
  docker?: {
    executable?: string;
    image?: string;
    user?: string;
  };
}

export interface EvalFileRunResult {
  record: EvalRunRecord;
  metrics: EvalRunMetrics;
}

export async function runEvalFiles(options: EvalFileRunOptions): Promise<EvalFileRunResult> {
  // 任务/模板与候选结果都来自外部文件，属不可信输入；加载后交给 validate/normalize 校验，
  // 且 taskPath 与 templatePath 二选一，避免同时输入造成歧义。
  if (Boolean(options.taskPath) === Boolean(options.templatePath)) {
    throw new Error('必须且只能指定 taskPath 或 templatePath');
  }
  if (options.templatePath && options.seed === undefined) throw new Error('动态模板必须指定 seed');
  const task = options.taskPath
    ? await readJson<EvalTaskDefinition>(options.taskPath)
    : new DynamicTaskGenerator().generate(
      await readJson<EvalTaskTemplate>(options.templatePath!),
      options.seed!,
    );
  const candidate = normalizeCandidate(await readJson<unknown>(options.candidatePath));
  const runner: EvalCandidateRunner = {
    run: async () => structuredClone(candidate),
  };
  const resultStore = new EvalResultStore(options.resultPath);
  try {
    const harness = new EvalHarness(runner, {
      resultStore,
      retainFailedWorkspace: options.retainFailedWorkspace,
      sandbox: options.docker ? new DockerSandboxAdapter(options.docker) : undefined,
    });
    const record = await harness.run(task, new AbortController().signal, options.suiteId);
    return { record, metrics: calculateRunMetrics(record) };
  } finally {
    await resultStore.close();
  }
}

async function readJson<T>(filePath: string): Promise<T> {
  // 读取前先做大小上限与文件类型校验，避免把超大或非常规文件一次性载入内存。
  const absolute = path.resolve(filePath);
  const info = await stat(absolute);
  if (!info.isFile() || info.size > 5 * 1024 * 1024) throw new Error(`Eval 文件无效或过大：${absolute}`);
  const text = await readFile(absolute, 'utf8');
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`Eval JSON 无效：${absolute}`);
  }
}

function normalizeCandidate(value: unknown): EvalCandidateResult {
  // 候选结果同为不可信输入：对字符串长度与 patch/events/evidenceIds 数量做上限校验，
  // 防止越界数据进入评分或持久化，再复制以隔离调用方。
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Eval Candidate 必须是对象');
  const candidate = value as Record<string, unknown>;
  if (candidate.answer !== undefined && typeof candidate.answer !== 'string') throw new Error('Candidate answer 必须是字符串');
  if (typeof candidate.answer === 'string' && candidate.answer.length > 50_000) throw new Error('Candidate answer 过长');
  if (candidate.patch !== undefined && (!candidate.patch || typeof candidate.patch !== 'object' || Array.isArray(candidate.patch))) {
    throw new Error('Candidate patch 必须是对象');
  }
  if (candidate.events !== undefined && (!Array.isArray(candidate.events) || candidate.events.length > 10_000)) {
    throw new Error('Candidate events 无效或过多');
  }
  if (candidate.evidenceIds !== undefined && (!Array.isArray(candidate.evidenceIds)
    || candidate.evidenceIds.length > 1_000
    || candidate.evidenceIds.some((item) => typeof item !== 'string'))) {
    throw new Error('Candidate evidenceIds 无效或过多');
  }
  return structuredClone(candidate) as EvalCandidateResult;
}
