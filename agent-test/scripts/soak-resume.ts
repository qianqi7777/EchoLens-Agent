import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { textMessage, type ToolCallItem } from '../../src/core/messages.js';
import type { ModelProvider, ProviderCapabilities, ProviderResult } from '../../src/providers/types.js';
import { ReactAgent } from '../../src/runtime/resumable-react-agent.js';
import { ToolExecutor } from '../../src/runtime/tool-executor.js';
import { ToolRegistry } from '../../src/runtime/tool-registry.js';
import { toolFailure, toolSuccess } from '../../src/runtime/tool-result.js';
import { SessionRuntime } from '../../src/session/session-runtime.js';
import type { AgentEvent } from '../../src/session/events.js';

type FaultCase = 'tool-execution-process-kill' | 'model-timeout' | 'tool-failure' | 'approval-wait';
interface AttemptResult { caseId: FaultCase; round: number; recovered: boolean; initialState?: string; resumedState?: string; events: string[]; error?: string }

const capabilities: ProviderCapabilities = {
  maxContextTokens: 8_192, supportsStreaming: false, supportsToolCalls: true,
  supportsParallelToolCalls: false, supportsStructuredOutput: false, supportsPromptCaching: false, supportsUsageReporting: false,
};
const toolCall: ToolCallItem = { type: 'tool_call', id: 'probe-item', callId: 'probe-call', name: 'probe', arguments: {}, callIndex: 0 };

async function main(): Promise<void> {
  if (process.argv.includes('--child-run')) {
    await childRun();
    return;
  }
  const rounds = parseRounds(process.argv);
  const output = option(process.argv, '--output') ?? join(process.cwd(), '.echolens', 'evals', 'results', `resume-faults-${new Date().toISOString().replace(/[:.]/gu, '-')}.json`);
  const cases: FaultCase[] = ['tool-execution-process-kill', 'model-timeout', 'tool-failure', 'approval-wait'];
  const attempts: AttemptResult[] = [];
  for (const caseId of cases) for (let round = 1; round <= rounds; round += 1) {
    console.error(`resume-soak case=${caseId} round=${round}`);
    attempts.push(await withTimeout(runAttempt(caseId, round), 15_000, caseId, round));
  }
  const recovered = attempts.filter((item) => item.recovered).length;
  const report = {
    version: 1, suite: 'resume-faults', generatedAt: new Date().toISOString(), roundsPerCase: rounds,
    denominator: attempts.length, recovered, recoveryRate: attempts.length ? recovered / attempts.length : 0,
    cases: cases.map((caseId) => {
      const selected = attempts.filter((item) => item.caseId === caseId);
      return { id: caseId, denominator: selected.length, recovered: selected.filter((item) => item.recovered).length, attempts: selected };
    }),
  };
  await mkdir(resolve(output, '..'), { recursive: true });
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  console.log(JSON.stringify({ output, denominator: report.denominator, recovered: report.recovered, recoveryRate: report.recoveryRate }));
}

async function runAttempt(caseId: FaultCase, round: number): Promise<AttemptResult> {
  const root = await mkdtemp(join(tmpdir(), `echolens-resume-${caseId}-${round}-`));
  const sessionRoot = join(root, 'sessions');
  const events: string[] = [];
  if (caseId === 'tool-execution-process-kill') {
    return runProcessKillAttempt(root, sessionRoot, caseId, round, events);
  }
  let modelCalls = 0;
  const registry = new ToolRegistry();
  registry.register({
    name: 'probe', description: '本地恢复压测工具', permission: caseId === 'approval-wait' ? 'workspace.write' : 'workspace.read',
    effect: caseId === 'approval-wait' ? 'write' : 'read',
    inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
    async execute() {
      if (caseId === 'tool-failure') return toolFailure('failed', 'tool_failed', '注入的工具失败');
      return toolSuccess('probe ok', '本地恢复探针完成');
    },
  });
  const provider: ModelProvider = {
    model: `resume-${caseId}`, capabilities,
    async complete(): Promise<ProviderResult> {
      modelCalls += 1;
      if (caseId === 'model-timeout' && modelCalls === 1) {
        const error = Object.assign(new Error('注入模型超时'), { code: 'timeout', retryable: false });
        throw error;
      }
      if (modelCalls === 1) return { output: [textMessage('assistant-tools', 'assistant', ''), toolCall], stopReason: 'tool_calls' };
      if (caseId === 'tool-failure' && modelCalls === 2) {
        const error = Object.assign(new Error('工具失败后注入退出'), { code: 'timeout', retryable: false });
        throw error;
      }
      return { output: [textMessage('assistant-final', 'assistant', '恢复完成')], stopReason: 'completed' };
    },
  };
  const approvalDecider = caseId === 'approval-wait' ? async () => undefined : undefined;
  const agent = new ReactAgent(provider, registry, new ToolExecutor(registry, { approvalDecider }), {
    workspaceRoot: root,
    permissions: new Set(['workspace.read', 'workspace.write']),
  });
  let session: SessionRuntime | undefined;
  let initialState: string | undefined;
  let error: string | undefined;
  try {
    session = await SessionRuntime.open(agent, { rootDirectory: sessionRoot, workspaceRoot: root, sessionId: `resume-${caseId}-${round}` });
    const runPromise = session.run('执行恢复探针', undefined, (event: AgentEvent) => {
      events.push(event.payload.type);
      if (event.payload.type === 'tool.started' && caseId === 'approval-wait') void session?.pause();
    });
    try { const result = await runPromise; initialState = result.state; }
    catch (runError) { error = runError instanceof Error ? runError.message : String(runError); }
    await session.close(); session = undefined;
    const resumeProvider: ModelProvider = { ...provider, async complete(): Promise<ProviderResult> {
      return { output: [textMessage('assistant-final', 'assistant', '恢复完成')], stopReason: 'completed' };
    } };
    const resumed = await SessionRuntime.open(new ReactAgent(resumeProvider, registry, new ToolExecutor(registry, {
      approvalDecider: caseId === 'approval-wait' ? async () => ({
        decision: 'allow' as const, scope: 'once' as const, decidedAt: new Date().toISOString(),
      }) : undefined,
    }), { workspaceRoot: root, permissions: new Set(['workspace.read', 'workspace.write']) }), {
      rootDirectory: sessionRoot, workspaceRoot: root, sessionId: `resume-${caseId}-${round}`,
    });
    const result = await resumed.resume(undefined, (event) => { events.push(event.payload.type); });
    const recovered = result.state === 'completed';
    await resumed.close();
    return { caseId, round, recovered, initialState, resumedState: result.state, events, error };
  } catch (runError) {
    error = runError instanceof Error ? runError.message : String(runError);
    await session?.close().catch(() => undefined);
    return { caseId, round, recovered: false, initialState, events, error };
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function runProcessKillAttempt(
  root: string,
  sessionRoot: string,
  caseId: FaultCase,
  round: number,
  events: string[],
): Promise<AttemptResult> {
  const sessionId = `resume-${caseId}-${round}`;
  const marker = join(root, 'tool-started.marker');
  const child = spawn(process.execPath, [
    '--import', 'tsx', fileURLToPath(import.meta.url), '--child-run', root, sessionRoot, sessionId, marker,
  ], { stdio: 'ignore', windowsHide: true });
  try {
    await waitForFile(marker, 10_000);
    events.push('tool.started', 'process.killed');
    child.kill('SIGKILL');
    await waitForExit(child, 10_000);
    const resumeProvider: ModelProvider = {
      model: 'resume-tool-execution-process-kill', capabilities,
      async complete(): Promise<ProviderResult> {
        return { output: [textMessage('assistant-final', 'assistant', '恢复完成')], stopReason: 'completed' };
      },
    };
    const registry = new ToolRegistry();
    registry.register({
      name: 'probe', description: '本地恢复压测工具', permission: 'workspace.read', effect: 'read',
      inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
      async execute() { return toolSuccess('probe ok', '本地恢复探针完成'); },
    });
    const resumed = await SessionRuntime.open(new ReactAgent(
      resumeProvider, registry, new ToolExecutor(registry), { workspaceRoot: root },
    ), { rootDirectory: sessionRoot, workspaceRoot: root, sessionId });
    const result = await resumed.resume(undefined, (event) => { events.push(event.payload.type); });
    const recovered = result.state === 'completed';
    await resumed.close();
    return { caseId, round, recovered, resumedState: result.state, events };
  } catch (runError) {
    return { caseId, round, recovered: false, events, error: runError instanceof Error ? runError.message : String(runError) };
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await waitForExit(child, 2_000).catch(() => undefined);
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function childRun(): Promise<void> {
  const [, , , root, sessionRoot, sessionId, marker] = process.argv;
  if (!root || !sessionRoot || !sessionId || !marker) throw new Error('child-run 参数缺失');
  const registry = new ToolRegistry();
  registry.register({
    name: 'probe', description: '本地恢复压测工具', permission: 'workspace.read', effect: 'read',
    inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
    async execute() {
      await writeFile(marker, 'tool.started\n', { encoding: 'utf8', mode: 0o600 });
      await new Promise<void>(() => undefined);
      return toolSuccess('unreachable', 'unreachable');
    },
  });
  let calls = 0;
  const provider: ModelProvider = {
    model: 'resume-tool-execution-process-kill', capabilities,
    async complete(): Promise<ProviderResult> {
      calls += 1;
      if (calls !== 1) throw new Error('child provider called after tool interruption');
      return { output: [textMessage('assistant-tools', 'assistant', ''), toolCall], stopReason: 'tool_calls' };
    },
  };
  const agent = new ReactAgent(provider, registry, new ToolExecutor(registry), { workspaceRoot: root });
  const session = await SessionRuntime.open(agent, { rootDirectory: sessionRoot, workspaceRoot: root, sessionId });
  await session.run('执行恢复探针');
}

async function waitForFile(path: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { await access(path); return; } catch { await new Promise((resolve) => setTimeout(resolve, 25)); }
  }
  throw new Error(`等待故障注入标记超时：${path}`);
}

async function waitForExit(child: ReturnType<typeof spawn>, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await Promise.race([
    new Promise<void>((resolve) => child.once('exit', () => resolve())),
    new Promise<void>((_, reject) => setTimeout(() => reject(new Error('等待子进程退出超时')), timeoutMs)),
  ]);
}

function parseRounds(argv: string[]): number {
  const value = Number(option(argv, '--rounds') ?? '3');
  if (!Number.isSafeInteger(value) || value < 1 || value > 100) throw new Error('--rounds 必须在 1-100');
  return value;
}
function option(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

async function withTimeout(promise: Promise<AttemptResult>, timeoutMs: number, caseId: FaultCase, round: number): Promise<AttemptResult> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<AttemptResult>((resolve) => { timer = setTimeout(() => resolve({ caseId, round, recovered: false, events: [], error: 'timeout' }), timeoutMs); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

await main();
