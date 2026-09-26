import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { textMessage, type ToolCallItem } from '../../src/core/messages.js';
import type { ModelProvider, ProviderCapabilities, ProviderResult } from '../../src/providers/types.js';
import { ReactAgent } from '../../src/runtime/resumable-react-agent.js';
import { ToolExecutor } from '../../src/runtime/tool-executor.js';
import { ToolRegistry } from '../../src/runtime/tool-registry.js';
import { toolSuccess } from '../../src/runtime/tool-result.js';
import { SessionRuntime } from '../../src/session/session-runtime.js';
import type { AgentEvent } from '../../src/session/events.js';

const capabilities: ProviderCapabilities = {
  maxContextTokens: 8_192, supportsStreaming: false, supportsToolCalls: true,
  supportsParallelToolCalls: false, supportsStructuredOutput: false, supportsPromptCaching: false,
  supportsUsageReporting: false,
};
const toolCall: ToolCallItem = { type: 'tool_call', id: 'soak-tool', callId: 'soak-call', name: 'probe', arguments: {}, callIndex: 0 };

interface Attempt {
  worker: number;
  attempt: number;
  state: string;
  toolExecutions: number;
  userModificationPreserved: boolean;
  duplicateToolExecution: boolean;
  taskRecoverable: boolean;
  events: string[];
  error?: string;
}

async function main(): Promise<void> {
  const concurrency = positiveOption('--concurrency', 4, 32);
  const seconds = positiveOption('--seconds', 1, 86_400);
  const rounds = positiveOption('--rounds', 0, 100_000);
  const output = option('--output') ?? join(process.cwd(), '.echolens', 'evals', 'results', `concurrency-${new Date().toISOString().replace(/[:.]/gu, '-')}.json`);
  const rawOutput = option('--raw-log') ?? output.replace(/\.json$/u, '.jsonl');
  const startedAt = Date.now();
  const attempts: Attempt[] = [];
  await Promise.all(Array.from({ length: concurrency }, (_, worker) => runWorker(worker, startedAt, seconds * 1_000, rounds, attempts)));
  const report = {
    version: 1, suite: 'concurrency-soak', generatedAt: new Date().toISOString(),
    requested: { concurrency, seconds, rounds: rounds || 'until-duration' },
    elapsedMs: Date.now() - startedAt, denominator: attempts.length,
    observations: {
      userModificationPreserved: attempts.filter((item) => item.userModificationPreserved).length,
      duplicateToolExecution: attempts.filter((item) => item.duplicateToolExecution).length,
      taskRecoverable: attempts.filter((item) => item.taskRecoverable).length,
    },
    attempts,
  };
  await mkdir(resolve(output, '..'), { recursive: true });
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await writeFile(rawOutput, attempts.map((item) => JSON.stringify(item)).join('\n') + (attempts.length ? '\n' : ''), { encoding: 'utf8', mode: 0o600 });
  console.log(JSON.stringify({ output, rawOutput, elapsedMs: report.elapsedMs, denominator: report.denominator, observations: report.observations }));
}

async function runWorker(worker: number, startedAt: number, durationMs: number, maxRounds: number, sink: Attempt[]): Promise<void> {
  let round = 0;
  while (maxRounds > 0 ? round < maxRounds : Date.now() - startedAt < durationMs) {
    round += 1;
    sink.push(await runAttempt(worker, round));
    if (maxRounds > 0 && round >= maxRounds) break;
  }
}

async function runAttempt(worker: number, attempt: number): Promise<Attempt> {
  const root = await mkdtemp(join(tmpdir(), `echolens-concurrency-${worker}-${attempt}-`));
  const sessionRoot = join(root, 'sessions');
  const file = join(root, 'shared.txt');
  const events: string[] = [];
  let toolExecutions = 0;
  let session: SessionRuntime | undefined;
  try {
    const registry = new ToolRegistry();
    registry.register({
      name: 'probe', description: '并发恢复探针', permission: 'workspace.read', effect: 'read',
      inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
      async execute() {
        toolExecutions += 1;
        await writeFile(file, `agent-${worker}-${attempt}\n`, 'utf8');
        return toolSuccess('probe ok', '探针完成');
      },
    });
    let calls = 0;
    const provider: ModelProvider = {
      model: 'concurrency-soak', capabilities,
      async complete(): Promise<ProviderResult> {
        calls += 1;
        return calls === 1
          ? { output: [textMessage('assistant-tools', 'assistant', ''), toolCall], stopReason: 'tool_calls' }
          : { output: [textMessage('assistant-final', 'assistant', '完成')], stopReason: 'completed' };
      },
    };
    const agent = new ReactAgent(provider, registry, new ToolExecutor(registry), { workspaceRoot: root, navigationMode: 'off' });
    session = await SessionRuntime.open(agent, { rootDirectory: sessionRoot, workspaceRoot: root, sessionId: `soak-${worker}-${attempt}` });
    const first = await session.run('执行并发恢复探针', undefined, (event: AgentEvent) => {
      events.push(event.payload.type);
      if (event.payload.type === 'tool.completed') void session?.pause();
    });
    if (first.state !== 'paused') throw new Error(`并发压测未在检查点暂停：${first.state}`);
    await writeFile(file, `user-${worker}-${attempt}\n`, 'utf8');
    await session.close();
    session = undefined;
    const resumedRegistry = new ToolRegistry();
    resumedRegistry.register({
      name: 'probe', description: '并发恢复探针', permission: 'workspace.read', effect: 'read',
      inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
      async execute() { toolExecutions += 1; return toolSuccess('unexpected', '不应重复执行'); },
    });
    const resumedProvider: ModelProvider = {
      model: 'concurrency-soak', capabilities,
      async complete(): Promise<ProviderResult> { return { output: [textMessage('assistant-final', 'assistant', '恢复完成')], stopReason: 'completed' }; },
    };
    const resumed = await SessionRuntime.open(new ReactAgent(resumedProvider, resumedRegistry, new ToolExecutor(resumedRegistry), { workspaceRoot: root, navigationMode: 'off' }), {
      rootDirectory: sessionRoot, workspaceRoot: root, sessionId: `soak-${worker}-${attempt}`,
    });
    const result = await resumed.resume(undefined, (event) => { events.push(event.payload.type); });
    await resumed.close();
    const content = await readFile(file, 'utf8');
    return {
      worker, attempt, state: result.state, toolExecutions,
      userModificationPreserved: content === `user-${worker}-${attempt}\n`,
      duplicateToolExecution: toolExecutions > 1,
      taskRecoverable: result.state === 'completed', events,
    };
  } catch (error) {
    return { worker, attempt, state: 'failed', toolExecutions, userModificationPreserved: false, duplicateToolExecution: toolExecutions > 1, taskRecoverable: false, events, error: error instanceof Error ? error.message : String(error) };
  } finally {
    await session?.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
}

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function positiveOption(name: string, fallback: number, max: number): number {
  const raw = option(name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0 || value > max || (name !== '--rounds' && value < 1)) throw new Error(`${name} 参数无效`);
  return value;
}

await main();
