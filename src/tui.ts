import { stdin, stdout } from 'node:process';
import type { AgentEvent } from './session/events.js';
import type { AgentRunResult } from './runtime/resumable-react-agent.js';
import { previewApprovalRequest } from './approval-preview.js';
import {
  type ApprovalDecision,
  type ApprovalRequest,
  type EditCheckpoint,
  type EditVerificationResult,
} from './runtime/index.js';
import {
  executeBackgroundTaskCommand,
  isBackgroundTaskCommand,
  type BackgroundTaskCommands,
} from './orchestration/task-command.js';

const ESC = '\u001b[';
const RESET = `${ESC}0m`;
const DIM = `${ESC}2m`;
const CYAN = `${ESC}36m`;
const GREEN = `${ESC}32m`;
const YELLOW = `${ESC}33m`;
const RED = `${ESC}31m`;
const BLUE = `${ESC}34m`;
const MAGENTA = `${ESC}35m`;

export interface TuiOptions {
  model: string;
  route: string;
  privacy?: string;
  sessionId: string;
  workspaceRoot: string;
  run: (prompt: string, signal: AbortSignal, onEvent: (event: AgentEvent) => void) => Promise<AgentRunResult>;
  resume: (signal: AbortSignal, onEvent: (event: AgentEvent) => void) => Promise<AgentRunResult>;
  steer: (message: string) => Promise<void>;
  listSessions: () => Promise<readonly { sessionId: string; modifiedAt: string; bytes: number }[]>;
  verify: () => Promise<readonly EditVerificationResult[]>;
  rollback: (checkpoint: EditCheckpoint) => Promise<{ restoredPaths: string[]; skippedPaths: string[] }>;
  loadCheckpoint: (id: string) => Promise<EditCheckpoint>;
  backgroundTasks?: BackgroundTaskCommands;
  startupMessages?: readonly string[];
}

interface ApprovalPrompt {
  request: ApprovalRequest;
  resolve: (decision: ApprovalDecision) => void;
  stage: 'decision' | 'scope';
}

/** 依赖零增量的全屏终端界面，复用现有 Session/Runtime，不改变 Agent 协议。 */
export class TerminalUi {
  private readonly logs: string[] = [];
  private readonly history: string[] = [];
  private historyIndex = -1;
  private input = '';
  private stream = '';
  private status = '就绪';
  private busy = false;
  private activeAbort?: AbortController;
  private approval?: ApprovalPrompt;
  private stopped = false;
  private escapeBuffer = '';
  private spinnerIndex = 0;
  private spinnerTimer?: ReturnType<typeof setInterval>;
  private resizeHandler?: () => void;
  private dataHandler?: (chunk: string | Buffer) => void;

  constructor(private readonly options: TuiOptions) {}

  async start(): Promise<void> {
    if (!stdin.isTTY || !stdout.isTTY || !stdin.setRawMode) {
      throw new Error('当前终端不支持 TUI，请使用交互式终端运行');
    }
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    this.dataHandler = (chunk) => this.handleInput(String(chunk));
    stdin.on('data', this.dataHandler);
    stdout.write(`${ESC}?1049h${ESC}H${ESC}?25l`);
    this.resizeHandler = () => this.render();
    stdout.on('resize', this.resizeHandler);
    this.spinnerTimer = setInterval(() => {
      if (!this.busy) return;
      this.spinnerIndex = (this.spinnerIndex + 1) % 4;
      this.render();
    }, 140);
    this.log(`workspace ${this.options.workspaceRoot}`);
    this.log(`session ${this.options.sessionId}`);
    for (const message of this.options.startupMessages ?? []) this.log(message);
    this.render();
    await new Promise<void>((resolve) => {
      this.exitResolver = resolve;
    });
  }

  async requestApproval(request: ApprovalRequest): Promise<ApprovalDecision> {
    let preview = '';
    if (request.toolName === 'apply_patch' || request.toolName === 'apply_sandbox_patch') {
      try {
        preview = (await previewApprovalRequest(request))?.diff ?? '';
      } catch (error) {
        this.log(`Patch 预览失败：${error instanceof Error ? error.message : String(error)}`);
        return { decision: 'deny', scope: 'once', decidedAt: new Date().toISOString(), reason: 'Patch 预览失败' };
      }
    }
    if (preview) this.log(preview);
    this.approval = {
      request,
      stage: 'decision',
      resolve: () => undefined,
    };
    this.status = `需要审批：${request.toolName}（按 y 允许，n 拒绝）`;
    this.render();
    return new Promise<ApprovalDecision>((resolve) => {
      if (this.approval) this.approval.resolve = resolve;
    });
  }

  notify(message: string): void {
    this.log(message);
    this.render();
  }

  private exitResolver?: () => void;

  private handleInput(chunk: string): void {
    for (const character of chunk) {
      if (this.escapeBuffer) {
        this.escapeBuffer += character;
        if (/[A-Za-z~]/u.test(character)) {
          this.handleEscape(this.escapeBuffer);
          this.escapeBuffer = '';
        }
        continue;
      }
      if (character === '\u0003') {
        if (this.activeAbort && !this.activeAbort.signal.aborted) {
          this.activeAbort.abort('user_cancelled');
          this.status = '正在取消当前 Turn...';
          this.render();
        } else {
          this.stop();
        }
        continue;
      }
      if (character === '\u0004') { this.stop(); continue; }
      if (this.approval) { this.handleApprovalKey(character); continue; }
      if (character === '\r' || character === '\n') { void this.submit(); continue; }
      if (character === '\u007f' || character === '\b') {
        this.input = this.input.slice(0, -1);
      } else if (character === '\u001b') {
        this.escapeBuffer = character;
        continue;
      } else if (character >= ' ' && character !== '\u007f') {
        if (this.input.length < 20_000) this.input += character;
      }
      this.render();
    }
  }

  private handleEscape(sequence: string): void {
    const key = sequence.at(-1);
    if (key === 'A' && this.history.length > 0) {
      this.historyIndex = Math.max(0, this.historyIndex < 0 ? this.history.length - 1 : this.historyIndex - 1);
      this.input = this.history[this.historyIndex] ?? '';
    } else if (key === 'B' && this.historyIndex >= 0) {
      this.historyIndex += 1;
      this.input = this.history[this.historyIndex] ?? '';
      if (this.historyIndex >= this.history.length) this.historyIndex = -1;
    }
    this.render();
  }

  private handleApprovalKey(character: string): void {
    const approval = this.approval;
    if (!approval) return;
    const key = character.toLowerCase();
    if (approval.stage === 'decision') {
      if (key === 'n' || character === '\u001b') {
        this.resolveApproval({ decision: 'deny', scope: 'once', decidedAt: new Date().toISOString(), reason: '用户拒绝' });
      } else if (key === 'y') {
        approval.stage = 'scope';
        this.status = '已允许，选择记忆范围：1=本次 2=会话 3=项目 4=持久';
        this.render();
      }
      return;
    }
    const scopes = { '1': 'once', '2': 'session', '3': 'project', '4': 'persistent' } as const;
    const scope = scopes[character as keyof typeof scopes];
    if (scope) this.resolveApproval({ decision: 'allow', scope, decidedAt: new Date().toISOString(), reason: '用户已批准' });
  }

  private resolveApproval(decision: ApprovalDecision): void {
    const approval = this.approval;
    this.approval = undefined;
    this.status = decision.decision === 'allow' ? '审批通过，继续执行' : '审批拒绝';
    approval?.resolve(decision);
    this.render();
  }

  private async submit(): Promise<void> {
    const prompt = this.input.trim();
    this.input = '';
    if (!prompt || this.busy) { this.render(); return; }
    this.history.push(prompt);
    this.historyIndex = -1;
    this.log(`you ${prompt}`);
    if (prompt === '/exit' || prompt === '/quit') { this.stop(); return; }
    if (prompt === '/help') {
      this.log('/resume 继续 | /sessions 会话 | /tasks 后台任务 | /task help 委托 | /verify 验证 | /rollback <id> 回滚 | /steer <要求> | /clear 清屏 | /exit 退出');
      this.render();
      return;
    }
    if (isBackgroundTaskCommand(prompt)) {
      if (!this.options.backgroundTasks) {
        this.log('后台任务服务不可用。');
        this.render();
        return;
      }
      await this.runTask('正在处理后台任务...', async () => {
        const result = await executeBackgroundTaskCommand(prompt, this.options.backgroundTasks!);
        for (const line of result.lines) this.log(line);
      });
      return;
    }
    if (prompt === '/clear') {
      this.logs.length = 0;
      this.stream = '';
      this.render();
      return;
    }
    if (prompt === '/sessions') {
      try {
        const sessions = await this.options.listSessions();
        for (const item of sessions.slice(0, 20)) this.log(`${item.sessionId} | ${item.modifiedAt} | ${item.bytes} bytes`);
        if (sessions.length === 0) this.log('暂无 Session。');
      } catch (error) { this.log(`会话列表失败：${message(error)}`); }
      this.render();
      return;
    }
    if (prompt === '/verify') {
      await this.runTask('正在验证...', async () => {
        const results = await this.options.verify();
        for (const result of results) this.log(`${result.id}: ${result.status} - ${result.summary}`);
      });
      return;
    }
    if (prompt.startsWith('/rollback')) {
      const id = prompt.split(/\s+/u)[1];
      if (!id) { this.log('用法：/rollback <checkpoint-id>'); this.render(); return; }
      await this.runTask(`正在回滚 ${id}...`, async () => {
        const result = await this.options.rollback(await this.options.loadCheckpoint(id));
        this.log(`已恢复 ${result.restoredPaths.length} 个文件`);
        if (result.skippedPaths.length) this.log(`跳过后续修改：${result.skippedPaths.join(', ')}`);
      });
      return;
    }
    if (prompt.startsWith('/steer ')) {
      await this.runTask('正在写入 steering...', async () => { await this.options.steer(prompt.slice('/steer '.length)); });
      return;
    }
    await this.runAgent(prompt, prompt === '/resume');
  }

  private async runAgent(prompt: string, resume: boolean): Promise<void> {
    this.busy = true;
    this.stream = '';
    this.status = resume ? '恢复运行中' : '运行中';
    this.activeAbort = new AbortController();
    this.render();
    try {
      const result = resume
        ? await this.options.resume(this.activeAbort.signal, (event) => this.onEvent(event))
        : await this.options.run(prompt, this.activeAbort.signal, (event) => this.onEvent(event));
      if (result.answer.trim()) this.log(`assistant ${result.answer}`);
      this.stream = '';
      this.status = `${result.state} | turn=${result.turnId}`;
      if (!result.finalSummary.verified && result.state === 'completed') this.log('结构化结果未验证，以上内容仅作为 raw 输出。');
    } catch (error) {
      this.status = '运行失败';
      this.log(message(error));
    } finally {
      this.busy = false;
      this.activeAbort = undefined;
      this.render();
    }
  }

  private async runTask(label: string, task: () => Promise<void>): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.status = label;
    this.render();
    try { await task(); }
    catch (error) { this.log(message(error)); }
    finally { this.busy = false; this.status = '就绪'; this.render(); }
  }

  private onEvent(event: AgentEvent): void {
    const payload = event.payload;
    if (payload.type === 'model.started') this.status = `模型步骤 ${payload.step + 1}`;
    else if (payload.type === 'model.output.delta') this.stream += cleanDisplayText(payload.delta);
    else if (payload.type === 'tool.started') this.log(`工具 ${payload.toolName} 开始`);
    else if (payload.type === 'tool.progress') this.status = `工具 ${payload.toolName}：${payload.total ? `${payload.progress}/${payload.total}` : payload.progress}`;
    else if (payload.type === 'tool.completed') this.log(`工具 ${payload.toolName} ${payload.status} ${payload.elapsedMs}ms`);
    else if (payload.type === 'model.retry') this.log(`模型重试 ${payload.attempt}：${payload.code}`);
    else if (payload.type === 'approval.requested') this.status = `等待审批：${payload.permission}`;
    this.render();
  }

  private log(value: string): void {
    const clean = cleanDisplayText(value).replace(/\r/gu, '');
    for (const line of clean.split('\n')) this.logs.push(line.slice(0, 400));
    while (this.logs.length > 300) this.logs.shift();
  }

  private render(): void {
    if (this.stopped) return;
    const width = Math.max(40, stdout.columns || 80);
    const height = Math.max(12, stdout.rows || 24);
    const rule = '─'.repeat(Math.min(width, 120));
    const lines: string[] = [];
    lines.push(`${CYAN}◆ EchoLens Agent${RESET}  ${DIM}v0.6${RESET}  ${MAGENTA}${this.options.route}${RESET}  ${DIM}${this.options.privacy ?? 'full-context'}${RESET}`);
    lines.push(`${DIM}${truncate(this.options.model, width - 4)}${RESET}`);
    lines.push(`${DIM}${truncate(this.options.workspaceRoot, width - 4)}${RESET}`);
    lines.push(`${this.busy ? YELLOW : GREEN}${this.busy ? `${spinner(this.spinnerIndex)} ` : '● '}${truncate(this.status, width - 4)}${RESET}`);
    lines.push(rule);
    const body: string[] = [];
    body.push(`${BLUE}Activity${RESET}`);
    for (const line of this.logs.slice(-Math.max(1, height - 12))) body.push(colorizeLog(line));
    if (this.stream) {
      body.push(`${CYAN}◆ assistant${RESET}`);
      body.push(...wrap(this.stream, width - 4).slice(-Math.max(1, height - body.length - 8)));
    }
    if (this.approval) {
      body.push(`${YELLOW}┌ 审批请求 · ${this.approval.request.toolName}${RESET}`);
      body.push(`${YELLOW}│ ${truncate(this.approval.request.reason, width - 6)}${RESET}`);
      const action = approvalAction(this.approval.request);
      if (action) body.push(`${YELLOW}│ ${truncate(action, width - 6)}${RESET}`);
      body.push(`${YELLOW}└ ${this.approval.stage === 'decision' ? 'y 允许 · n 拒绝' : '1 本次 · 2 会话 · 3 项目 · 4 持久'}${RESET}`);
    }
    lines.push(...body.slice(-Math.max(1, height - 6)));
    while (lines.length < height - 2) lines.push('');
    lines.push(rule);
    lines.push(`${CYAN}›${RESET} ${this.input}${this.busy ? ` ${DIM}· Ctrl+C 取消${RESET}` : ` ${DIM}· ↑↓ 历史 · /help${RESET}`}`);
    stdout.write(`${ESC}2J${ESC}H${lines.slice(0, height).join('\n')}`);
  }

  private stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.activeAbort?.abort('user_exit');
    if (this.approval) {
      const approval = this.approval;
      this.approval = undefined;
      approval.resolve({
        decision: 'deny',
        scope: 'once',
        decidedAt: new Date().toISOString(),
        reason: 'TUI 已退出',
      });
    }
    if (this.dataHandler) stdin.off('data', this.dataHandler);
    if (this.resizeHandler) stdout.off('resize', this.resizeHandler);
    if (this.spinnerTimer) clearInterval(this.spinnerTimer);
    stdin.setRawMode?.(false);
    stdin.pause();
    stdout.write(`${ESC}?25h${ESC}?1049l\n`);
    this.exitResolver?.();
  }
}

function wrap(value: string, width: number): string[] {
  const result: string[] = [];
  for (const line of value.split('\n')) {
    if (line.length === 0) { result.push(''); continue; }
    for (let index = 0; index < line.length; index += width) result.push(line.slice(index, index + width));
  }
  return result;
}

function spinner(index: number): string {
  return ['⠋', '⠙', '⠹', '⠸'][index] ?? '⠋';
}

function truncate(value: string, width: number): string {
  const limit = Math.max(8, width);
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;
}

function colorizeLog(value: string): string {
  if (value.startsWith('+') && !value.startsWith('+++')) return `${GREEN}${value}${RESET}`;
  if (value.startsWith('-') && !value.startsWith('---')) return `${RED}${value}${RESET}`;
  if (value.startsWith('---') || value.startsWith('+++')) return `${BLUE}${value}${RESET}`;
  if (value.startsWith('Patch ') || value.startsWith('审批')) return `${YELLOW}${value}${RESET}`;
  if (value.startsWith('you ')) return `${CYAN}${value}${RESET}`;
  if (value.startsWith('assistant ')) return `${BLUE}${value}${RESET}`;
  return value;
}

function approvalAction(request: ApprovalRequest): string | undefined {
  const executable = request.arguments.executable;
  const args = request.arguments.args;
  if (typeof executable === 'string') {
    return `$ ${[executable, ...(Array.isArray(args) ? args.filter((value): value is string => typeof value === 'string') : [])].join(' ')}`;
  }
  const packages = request.arguments.packages;
  if (Array.isArray(packages)) return `packages: ${packages.filter((value) => typeof value === 'string').join(', ')}`;
  return undefined;
}

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, '');
}

function cleanDisplayText(value: string): string {
  return stripAnsi(value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, '');
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
