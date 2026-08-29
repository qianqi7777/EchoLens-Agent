import path from 'node:path';
import { runEvalFiles } from './evals/file-runner.js';

try {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
  } else {
    const result = await runEvalFiles({
      taskPath: args.task,
      templatePath: args.template,
      seed: args.seed,
      candidatePath: required(args.candidate, '--candidate'),
      resultPath: path.resolve(args.results ?? '.echolens/evals/results.jsonl'),
      suiteId: args.suite,
      retainFailedWorkspace: args.retainFailed,
      docker: args.docker ? {
        executable: process.env.AGENT_DOCKER_EXECUTABLE,
        image: process.env.AGENT_SANDBOX_IMAGE,
        user: process.env.AGENT_SANDBOX_USER,
      } : undefined,
    });
    const { record, metrics } = result;
    console.log(`eval=${record.taskId}@${record.taskVersion} status=${record.passed ? 'passed' : 'failed'} durationMs=${record.durationMs}`);
    for (const assertion of record.assertions) {
      console.log(`${assertion.passed ? 'PASS' : 'FAIL'} ${assertion.id}: ${assertion.summary}`);
    }
    console.log(`metrics steps=${metrics.modelSteps} tools=${metrics.toolCalls} invalidRate=${metrics.invalidToolCallRate.toFixed(4)} tokens=${metrics.inputTokens + metrics.outputTokens}`);
    if (record.workspaceRetained) console.log(`retained=${record.workspaceRetained}`);
    if (!record.passed) process.exitCode = 1;
  }
} catch (error) {
  console.error(`Eval 运行失败：${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}

interface ParsedArgs {
  task?: string;
  template?: string;
  seed?: string;
  candidate?: string;
  results?: string;
  suite?: string;
  docker: boolean;
  retainFailed: boolean;
  help: boolean;
}

function parseArgs(args: string[]): ParsedArgs {
  const result: ParsedArgs = { docker: false, retainFailed: false, help: false };
  for (let index = 0; index < args.length; index += 1) {
    const current = args[index]!;
    if (current === '--docker') result.docker = true;
    else if (current === '--retain-failed') result.retainFailed = true;
    else if (current === '--help' || current === '-h') result.help = true;
    else if (current === '--task') result.task = nextValue(args, ++index, current);
    else if (current === '--template') result.template = nextValue(args, ++index, current);
    else if (current === '--seed') result.seed = nextValue(args, ++index, current);
    else if (current === '--candidate') result.candidate = nextValue(args, ++index, current);
    else if (current === '--results') result.results = nextValue(args, ++index, current);
    else if (current === '--suite') result.suite = nextValue(args, ++index, current);
    else throw new Error(`未知参数：${current}`);
  }
  return result;
}

function nextValue(args: string[], index: number, option: string): string {
  const value = args[index];
  if (!value || value.startsWith('--')) throw new Error(`${option} 缺少值`);
  return value;
}

function required(value: string | undefined, option: string): string {
  if (!value) throw new Error(`缺少 ${option}`);
  return value;
}

function printHelp(): void {
  console.log([
    'EchoLens Eval（只读取本地任务与候选结果，不调用模型）',
    '  --task <file> | --template <file> --seed <seed>',
    '  --candidate <file> [--results <jsonl>] [--suite <id>]',
    '  [--docker] [--retain-failed]',
  ].join('\n'));
}
