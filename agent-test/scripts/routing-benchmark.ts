import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { ReactAgent } from '../../src/runtime/resumable-react-agent.js';
import { RoutedModelProvider, type ModelProfile } from '../../src/runtime/model-routing.js';
import type { ModelProvider, ProviderCapabilities, ProviderResult } from '../../src/providers/types.js';
import { textMessage } from '../../src/core/messages.js';
import { ToolRegistry } from '../../src/runtime/tool-registry.js';
import { ToolExecutor } from '../../src/runtime/tool-executor.js';

const capabilities: ProviderCapabilities = {
  maxContextTokens: 8_192, supportsStreaming: false, supportsToolCalls: false,
  supportsParallelToolCalls: false, supportsStructuredOutput: false, supportsPromptCaching: false,
  supportsUsageReporting: true,
};
interface Task { id: string; prompt: string }
interface Measurement { taskId: string; mode: string; state: string; model: string; steps: number; totalTokens: number; estimatedCost: number; latencyMs: number }

async function main(): Promise<void> {
  const tasks = await loadTasks();
  const measurements: Measurement[] = [];
  for (const mode of ['off', 'auto'] as const) {
    for (const task of tasks) measurements.push(await measure(mode, task));
  }
  const byMode = ['off', 'auto'].map((mode) => {
    const selected = measurements.filter((item) => item.mode === mode);
    const completed = selected.filter((item) => item.state === 'completed').length;
    return {
      mode, denominator: selected.length, completed, completionRate: selected.length ? completed / selected.length : 0,
      averageSteps: average(selected.map((item) => item.steps)), averageTokens: average(selected.map((item) => item.totalTokens)),
      averageLatencyMs: average(selected.map((item) => item.latencyMs)), estimatedCost: selected.reduce((sum, item) => sum + item.estimatedCost, 0),
    };
  });
  const output = option('--output') ?? join(process.cwd(), '.echolens', 'evals', 'results', `routing-benchmark-${new Date().toISOString().replace(/[:.]/gu, '-')}.json`);
  const report = { version: 1, suite: 'fixed-core', generatedAt: new Date().toISOString(), taskCount: tasks.length, comparison: byMode, measurements };
  await mkdir(resolve(output, '..'), { recursive: true });
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  console.log(JSON.stringify({ output, taskCount: tasks.length, comparison: byMode }));
}

async function loadTasks(): Promise<Task[]> {
  const root = resolve(process.cwd(), 'agent-test', 'fixtures', 'evals');
  const suite = JSON.parse(await readFile(join(root, 'suites', 'fixed-core.suite.json'), 'utf8')) as { entries: Array<{ task?: string; template?: string }> };
  const tasks: Task[] = [];
  for (const [index, entry] of suite.entries.entries()) {
    const file = entry.task ?? entry.template;
    if (!file) continue;
    const value = JSON.parse(await readFile(join(root, file), 'utf8')) as { id?: string; prompt?: string; task?: { prompt?: string } };
    tasks.push({ id: value.id ?? `${file}:${index}`, prompt: value.prompt ?? value.task?.prompt ?? `执行固定任务 ${index + 1}` });
  }
  return tasks;
}

async function measure(mode: 'off' | 'auto', task: Task): Promise<Measurement> {
  const profiles: ModelProfile[] = [
    { id: 'fast', provider: provider('fast', 12), tier: 1, privacy: 'full-context', estimatedInputCostPer1k: 0.001, estimatedOutputCostPer1k: 0.002, latencyHintMs: 5 },
    { id: 'quality', provider: provider('quality', 24), tier: 3, privacy: 'full-context', estimatedInputCostPer1k: 0.004, estimatedOutputCostPer1k: 0.008, latencyHintMs: 20 },
  ];
  const routed = new RoutedModelProvider(profiles, { mode });
  const registry = new ToolRegistry();
  const agent = new ReactAgent(routed, registry, new ToolExecutor(registry), { workspaceRoot: process.cwd(), navigationMode: 'off' });
  const started = Date.now();
  const result = await agent.run(task.prompt);
  const usage = result.items.length * 2;
  const cost = usage / 1_000 * (routed.model === 'quality' ? 0.012 : 0.003);
  return { taskId: task.id, mode, state: result.state, model: routed.model, steps: result.checkpoint.step, totalTokens: usage, estimatedCost: cost, latencyMs: Date.now() - started };
}

function provider(model: string, tokens: number): ModelProvider {
  return { model, capabilities, async complete(): Promise<ProviderResult> {
    return { output: [textMessage(`${model}-answer`, 'assistant', 'benchmark-complete')], stopReason: 'completed', usage: { inputTokens: tokens, outputTokens: 2, totalTokens: tokens + 2 } };
  } };
}

function average(values: number[]): number { return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0; }
function option(name: string): string | undefined { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : undefined; }

await main();
