// Eval 命令行入口。只读取本地任务定义与候选结果文件，不发起任何模型请求，
// 因此可以在没有凭据的网络隔离环境里运行。
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
      // 失败时保留工作区只用于人工排查，默认关闭以免磁盘被大量失败用例占满。
      retainFailedWorkspace: args.retainFailed,
      // 只有显式 --docker 才读取沙箱环境变量：未开启时不探测 Docker，
      // 避免没有 Docker 的机器上把普通用例判成沙箱失败。
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
    // invalidRate 固定 4 位小数：浮点尾数在不同 Node 版本上会抖动，固定精度才能让日志可直接比对。
    console.log(`metrics steps=${metrics.modelSteps} tools=${metrics.toolCalls} invalidRate=${metrics.invalidToolCallRate.toFixed(4)} tokens=${metrics.inputTokens + metrics.outputTokens}`);
    if (record.workspaceRetained) console.log(`retained=${record.workspaceRetained}`);
    // 用 exitCode 而不是 process.exit：后者可能在 stdout 刷新完成前就终止进程，导致日志截断。
    if (!record.passed) process.exitCode = 1;
  }
} catch (error) {
  // 只回显 message：完整堆栈会带上任务文件与工作区的本地绝对路径。
  console.error(`Eval 运行失败：${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}

// 所有开关默认关闭，缺失即视为不使用，避免隐式启用沙箱或保留工作区。
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

// 逐个扫描而非按位置解析：遇到无法识别的参数立即报错，避免拼错的参数被静默忽略。
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
  // 以 -- 开头视为值缺失而不是值本身，否则 `--task --candidate x` 会被解析成 task='--candidate'。
  if (!value || value.startsWith('--')) throw new Error(`${option} 缺少值`);
  return value;
}

// --candidate 必填：没有候选实现就没有可比对的运行结果。
function required(value: string | undefined, option: string): string {
  if (!value) throw new Error(`缺少 ${option}`);
  return value;
}

// 帮助文本显式声明不调用模型，避免把它误当成会产生费用的命令。
function printHelp(): void {
  console.log([
    'EchoLens Eval（只读取本地任务与候选结果，不调用模型）',
    '  --task <file> | --template <file> --seed <seed>',
    '  --candidate <file> [--results <jsonl>] [--suite <id>]',
    '  [--docker] [--retain-failed]',
  ].join('\n'));
}
