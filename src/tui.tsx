import { stdin, stdout } from 'node:process';
import React, { useMemo, useSyncExternalStore } from 'react';
import stringWidth from 'string-width';
import wrapAnsi from 'wrap-ansi';
import {
  Box,
  Spacer,
  Text,
  render,
  useInput,
  useWindowSize,
  type Key,
} from 'ink';
import type { AgentEvent } from './session/events.js';
import type { AgentRunResult } from './runtime/resumable-react-agent.js';
import { previewApprovalRequest, type ApprovalPreview } from './approval-preview.js';
import type {
  ApprovalDecision,
  ApprovalRequest,
  EditCheckpoint,
  EditVerificationResult,
  FinalSummary,
  ToolExecutionStatus,
} from './runtime/index.js';
import {
  executeBackgroundTaskCommand,
  isBackgroundTaskCommand,
  type BackgroundTaskCommands,
} from './orchestration/task-command.js';
import {
  executeWorkspaceCommand,
  isWorkspaceCommand,
  type WorkspaceCommandService,
} from './runtime/workspace-manager.js';
import {
  completeCommand,
  filterCommandCandidates,
  formatCommandHelp,
  getCommandCatalog,
  parseCommandInput,
  commandMenuWindow,
  type CommandDescriptor,
} from './commands/command-catalog.js';
import { completeArguments } from './commands/argument-completion.js';
import { executeSessionCommand } from './commands/session-command.js';
import type { SessionDescriptor } from './session/jsonl-event-store.js';

type MenuCandidate = CommandDescriptor & { replacement?: string };

const DEFAULT_HEIGHT = 24;
// 主题色集中在此：TUI 所有组件共享同一套色板，调整外观只改这里。
const BRAND = '#d97757';
const ACCENT = '#7aa2f7';
const DIM = '#63666c';
const MUTED = '#9aa0a6';
const GOOD = '#3fb27f';
const BAD = '#e5484d';
const WARN = '#f5a524';
const BODY = '#e6e6e6';

/**
 * TUI 的装配参数。所有能力都以回调注入，TerminalUi 不直接依赖 Session/Runtime 实现，
 * 这样既能复用现有协议，也便于测试时替换成假实现。
 */
export interface TuiOptions {
  model: string;
  route: string;
  privacy?: string;
  sessionId: string;
  workspaceRoot: string;
  maxContextTokens?: number;
  run: (prompt: string, signal: AbortSignal, onEvent: (event: AgentEvent) => void) => Promise<AgentRunResult>;
  resume: (signal: AbortSignal, onEvent: (event: AgentEvent) => void) => Promise<AgentRunResult>;
  steer: (message: string) => Promise<void>;
  listSessions: () => Promise<readonly { sessionId: string; modifiedAt: string; bytes: number }[]>;
  deleteSession?: (session: SessionDescriptor) => Promise<void>;
  verify: () => Promise<readonly EditVerificationResult[]>;
  rollback: (checkpoint: EditCheckpoint) => Promise<{ restoredPaths: string[]; skippedPaths: string[] }>;
  loadCheckpoint: (id: string) => Promise<EditCheckpoint>;
  backgroundTasks?: BackgroundTaskCommands;
  workspaceCommands?: WorkspaceCommandService;
  startupMessages?: readonly string[];
}

// ---- Transcript model -------------------------------------------------------

type Tone = 'info' | 'success' | 'warn' | 'error' | 'dim';

// 会话转录的渲染模型：把 Session 事件流归一成五种可渲染条目。
// 每条有稳定 id（seq 生成），React 用 key 做增量更新；streaming 标记驱动光标与收尾逻辑。
type ViewItem =
  | { kind: 'user'; id: string; text: string }
  | { kind: 'assistant'; id: string; text: string; streaming: boolean; summary?: FinalSummary }
  | {
      kind: 'tool';
      id: string;
      callId: string;
      toolName: string;
      streaming: boolean;
      status?: string;
      statusColor?: string;
      elapsedMs?: number;
      detail?: string;
    }
  | { kind: 'notice'; id: string; text: string; tone: Tone }
  | { kind: 'patch'; id: string; text: string };

interface ApprovalUi {
  request: ApprovalRequest;
  stage: 'decision' | 'scope';
  preview?: ApprovalPreview;
  resolve: (decision: ApprovalDecision) => void;
}

interface TuiState {
  transcript: ViewItem[];
  busy: boolean;
  status: string;
  statusTone: Tone;
  input: string;
  inputCursor: number;
  historyDraft: string;
  argumentInput: string;
  argumentCandidates: MenuCandidate[];
  confirmation?: { message: string; resolve: (confirmed: boolean) => void };
  history: string[];
  historyIndex: number;
  scrollFromBottom: number;
  approval?: ApprovalUi;
  tokens: number;
  maxContext?: number;
  model: string;
  route: string;
  privacy?: string;
  workspaceRoot: string;
  sessionId: string;
  commandMenuSelection: number;
  commandMenuDismissed: boolean;
}

interface Segment {
  text: string;
  color?: string;
  dim?: boolean;
  bold?: boolean;
}
interface Line {
  key: string;
  segments: Segment[];
}

// ---- Tiny reactive store (injected into React via useSyncExternalStore) -------

// 极简外部状态源：全部状态集中在一个不可变对象里，更新走 fn(prev) => next，
// 通知订阅者后由 useSyncExternalStore 触发重渲染。不用 Context/Reducer 是因为
// 事件回调（onEvent）来自 React 树之外，需要一个独立于组件的存储。
class UiStore {
  private state: TuiState;
  private readonly listeners = new Set<() => void>();

  constructor(initial: TuiState) {
    this.state = initial;
  }

  get = (): TuiState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  update(fn: (prev: TuiState) => TuiState): void {
    this.state = fn(this.state);
    for (const listener of this.listeners) listener();
  }
}

// ---- Layout helpers ---------------------------------------------------------

/**
 * 按终端显示列宽换行，兼容中文全角字符与无空格长串。
 *
 * 先用 `\r` 清洗再用 wrapAnsi 逐段硬换行：wrapAnsi 按显示宽度（ANSI 转义不计宽）
 * 工作，硬换行保证没有空格的超长 token 也不会撑破布局。
 */
export function wrapDisplayText(text: string, width: number): string[] {
  const columns = Math.max(1, width);
  return text.replace(/\r/g, '').split('\n').flatMap((paragraph) => {
    if (!paragraph) return [''];
    return wrapAnsi(paragraph, columns, { hard: true, trim: false, wordWrap: true }).split('\n');
  });
}

/**
 * 按显示宽度截断文本并以省略号结尾。
 * @returns 不超宽时原样返回；宽度不足 1 时只返回省略号，避免产生空行。
 */
export function truncateDisplayText(value: string, width: number): string {
  if (stringWidth(value) <= width) return value;
  if (width <= 1) return '…';
  let output = '';
  // 逐字符累计并预检“加省略号后的宽度”：提前终止保证最终结果严格不超过 width。
  for (const character of value) {
    if (stringWidth(`${output}${character}…`) > width) break;
    output += character;
  }
  return `${output}…`;
}

function toneColor(tone: Tone): string {
  if (tone === 'success') return GOOD;
  if (tone === 'warn') return WARN;
  if (tone === 'error') return BAD;
  if (tone === 'dim') return DIM;
  return MUTED;
}

function diffColor(line: string): string {
  if (line.startsWith('+') && !line.startsWith('+++')) return GOOD;
  if (line.startsWith('-') && !line.startsWith('---')) return BAD;
  if (line.startsWith('+++') || line.startsWith('---')) return ACCENT;
  return DIM;
}

function looksJsonish(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.startsWith('{') || trimmed.startsWith('```');
}

function itemLines(item: ViewItem, width: number): Line[] {
  const out: Line[] = [];
  switch (item.kind) {
    case 'user': {
      const prefix = '❯ ';
      const body = wrapDisplayText(item.text, Math.max(1, width - prefix.length));
      body.forEach((line, index) => {
        out.push({
          key: `${item.id}:u${index}`,
          segments: index === 0
            ? [
                { text: ` ${prefix}`, color: BRAND, bold: true },
                { text: line, color: BODY },
              ]
            : [{ text: ' '.repeat(prefix.length + 1), color: BODY }, { text: line, color: BODY }],
        });
      });
      break;
    }
    case 'assistant': {
      if (item.streaming && looksJsonish(item.text)) {
        out.push({ key: `${item.id}:gen`, segments: [{ text: '  正在组织最终答案…▍', color: DIM }] });
        break;
      }
      if (item.summary) {
        const presented = item.summary;
        let seq = 0;
        const sectionKey = () => `${item.id}:s${seq += 1}`;
        const answerLines = wrapDisplayText(presented.answer, Math.max(1, width - 1));
        if (answerLines.length === 0 && item.streaming) {
          out.push({ key: sectionKey(), segments: [{ text: ' ▍', color: BRAND }] });
          break;
        }
        answerLines.forEach((line, index) => {
          const last = index === answerLines.length - 1;
          const suffix = item.streaming && last ? ' ▍' : '';
          out.push({ key: sectionKey(), segments: [{ text: ` ${line}${suffix}`, color: BODY }] });
        });
        const passed = presented.verification.filter((v) => v.status === 'passed').length;
        if (presented.verification.length > 0) {
          out.push({
            key: sectionKey(),
            segments: [
              { text: '  • 验证 ', color: DIM },
              { text: `${passed}/${presented.verification.length}`, color: passed === presented.verification.length ? GOOD : WARN, bold: true },
              { text: ' 通过', color: DIM },
            ],
          });
        }
        for (const change of presented.changes.slice(0, 6)) {
          out.push({ key: sectionKey(), segments: [{ text: `  + ${truncateDisplayText(change, Math.max(1, width - 4))}`, color: GOOD }] });
        }
        for (const warning of presented.warnings.slice(0, 4)) {
          out.push({ key: sectionKey(), segments: [{ text: `  ! ${truncateDisplayText(warning, Math.max(1, width - 4))}`, color: WARN }] });
        }
        for (const unresolved of presented.unresolved.slice(0, 4)) {
          out.push({ key: sectionKey(), segments: [{ text: `  ? ${truncateDisplayText(unresolved, Math.max(1, width - 4))}`, color: BAD }] });
        }
        break;
      }
      if (looksJsonish(item.text)) {
        const code = item.text
          .replace(/^```[A-Za-z0-9_-]*[ \t]*\n/u, '')
          .replace(/\n```[ \t]*$/u, '')
          .trimEnd();
        code.split('\n').slice(0, 12).forEach((line, index) => {
          out.push({ key: `${item.id}:j${index}`, segments: [{ text: ` ${line}`, color: DIM }] });
        });
        break;
      }
      const body = wrapDisplayText(item.text, Math.max(1, width - 1));
      if (body.length === 0 && item.streaming) {
        out.push({ key: `${item.id}:a0`, segments: [{ text: ' ▍', color: BRAND }] });
        break;
      }
      body.forEach((line, index) => {
        const last = index === body.length - 1;
        const suffix = item.streaming && last ? ' ▍' : '';
        out.push({
          key: `${item.id}:a${index}`,
          segments: [{ text: ` ${line}${suffix}`, color: BODY }],
        });
      });
      break;
    }
    case 'tool': {
      const icon = item.streaming ? '…' : (item.statusColor ? '✓' : '·');
      out.push({
        key: `${item.id}:t`,
        segments: [
          { text: ' ⎿  ', color: ACCENT },
          { text: item.toolName, color: ACCENT, bold: true },
          ...(item.status
            ? [{ text: `  ·  ${icon} ${item.status}`, color: item.statusColor ?? DIM, bold: true }]
            : []),
          ...(item.elapsedMs != null ? [{ text: `  ·  ${item.elapsedMs}ms`, color: DIM }] : []),
        ],
      });
      if (item.detail) {
        const detail = wrapDisplayText(item.detail, Math.max(1, width - 4)).slice(0, 3);
        detail.forEach((line, index) => {
          out.push({
            key: `${item.id}:d${index}`,
            segments: [{ text: `    ${line}`, color: DIM }],
          });
        });
      }
      break;
    }
    case 'notice': {
      const color = toneColor(item.tone);
      const body = wrapDisplayText(item.text, Math.max(1, width - 2));
      body.forEach((line, index) => {
        out.push({
          key: `${item.id}:n${index}`,
          segments: [
            ...(index === 0 ? [{ text: ' • ', color, bold: true }] : [{ text: '  ' }]),
            { text: line, color: item.tone === 'info' ? MUTED : color },
          ],
        });
      });
      break;
    }
    case 'patch': {
      item.text.split('\n').forEach((line, index) => {
        out.push({
          key: `${item.id}:p${index}`,
          segments: [{ text: line, color: diffColor(line) }],
        });
      });
      break;
    }
  }
  return out;
}

function transcriptLines(transcript: readonly ViewItem[], width: number): Line[] {
  const out: Line[] = [];
  for (const item of transcript) out.push(...itemLines(item, width));
  return out;
}

// ---- Approval preview --------------------------------------------------------

function approvalActionText(request: ApprovalRequest): string | undefined {
  const executable = request.arguments.executable;
  const args = request.arguments.args;
  if (typeof executable === 'string') {
    return `$ ${[executable, ...(Array.isArray(args) ? args.filter((v): v is string => typeof v === 'string') : [])].join(' ')}`;
  }
  const packages = request.arguments.packages;
  if (Array.isArray(packages)) {
    return `packages: ${packages.filter((v) => typeof v === 'string').join(', ')}`;
  }
  if (typeof request.arguments.path === 'string') return `path: ${request.arguments.path}`;
  return undefined;
}

function approvalLines(approval: ApprovalUi, width: number, max: number): Line[] {
  const request = approval.request;
  const out: Line[] = [];
  out.push({ key: 'aph', segments: [{ text: `┌ 审批 · ${request.toolName}`, color: WARN, bold: true }] });
  out.push({ key: 'apr', segments: [{ text: `│ 原因: ${truncateDisplayText(request.reason, width - 4)}`, color: MUTED }] });
  const action = approvalActionText(request);
  if (action) out.push({ key: 'apa', segments: [{ text: `│ ${truncateDisplayText(action, width - 4)}`, color: BODY }] });
  if (approval.preview && approval.preview.diff) {
    const lines = approval.preview.diff.split('\n');
    const shown = lines.slice(0, Math.max(1, Math.min(10, max - out.length - 1)));
    shown.forEach((line, index) => {
      out.push({ key: `app${index}`, segments: [{ text: `│ ${line}`, color: diffColor(line) }] });
    });
  }
  out.push({
    key: 'aphint',
    segments: [
      {
        text: `└ ${approval.stage === 'decision' ? '[y] 允许 · [n] 拒绝 · [Esc] 拒绝' : '允许范围: [1]本次 [2]会话 [3]项目 [4]持久'}`,
        color: WARN,
        bold: true,
      },
    ],
  });
  return out.slice(0, max);
}

// ---- Presentational components -----------------------------------------------

function Header({ state }: { state: TuiState }): React.JSX.Element {
  return (
    <Box justifyContent="space-between">
      <Text>
        <Text color={BRAND} bold>◆ EchoLens Agent</Text>
        <Text color={DIM}>  ·  {state.route}{state.privacy ? `  ·  ${state.privacy}` : ''}</Text>
      </Text>
      <Text color={DIM}>{truncateDisplayText(state.workspaceRoot, 40)}</Text>
    </Box>
  );
}

function PromptLine({ state, width }: { state: TuiState; width: number }): React.JSX.Element {
  const before = state.input.slice(0, state.inputCursor).replace(/\n/gu, '↵');
  const after = state.input.slice(state.inputCursor).replace(/\n/gu, '↵');
  const visible = inputViewport(before, after, Math.max(1, width - 3));
  return (
    <Box height={1} overflow="hidden">
      <Text wrap="truncate">
        <Text color={BRAND} bold>❯ </Text>
        <Text color={BODY}>{visible.before}<Text color={BRAND}>▌</Text>{visible.after}</Text>
      </Text>
    </Box>
  );
}

function CommandMenu({
  items,
  selected,
  width,
  capacity,
}: {
  items: readonly CommandDescriptor[];
  selected: number;
  width: number;
  capacity: number;
}): React.JSX.Element | null {
  if (items.length === 0) return null;
  const window = commandMenuWindow(items.length, selected, capacity);
  const visible = items.slice(window.start, window.end);
  if (visible.length === 0) return null;
  return (
    <Box flexDirection="column" width={width}>
      {visible.map((command, index) => {
        index += window.start;
        const marker = index === selected ? '›' : ' ';
        const usage = command.usage ?? command.name;
        const aliases = command.aliases?.length ? `  别名 ${command.aliases.join('、')}` : '';
        const detail = `${usage}  ${command.description}${aliases}`;
        return (
          <Text key={command.name} wrap="truncate">
            <Text color={index === selected ? BRAND : DIM} bold={index === selected}>{marker} </Text>
            <Text color={index === selected ? ACCENT : BODY} bold={index === selected}>{truncateDisplayText(detail, Math.max(1, width - 2))}</Text>
          </Text>
        );
      })}
    </Box>
  );
}

function StatusBar({ state, compact }: { state: TuiState; compact: boolean }): React.JSX.Element {
  const pct = state.maxContext && state.maxContext > 0
    ? Math.min(999, Math.round((state.tokens / state.maxContext) * 100))
    : undefined;
  const session = state.sessionId.slice(0, 8);
  return (
    <Box justifyContent="space-between">
      <Text wrap="truncate">
        {state.busy ? <Text color={WARN}>{state.status}  ·  </Text> : null}
        <Text color={BRAND} bold>model {state.model}</Text>
        <Text color={MUTED}>  ·  route {state.route}</Text>
        {pct != null ? <Text color={pct > 70 ? WARN : MUTED}>  ·  ctx {pct}%</Text> : null}
        <Text color={MUTED}>  ·  session {session}</Text>
      </Text>
      <Spacer />
      {!compact ? <Text color={DIM} dimColor>Shift+↑↓ / PgUp·PgDn 滚动</Text> : null}
    </Box>
  );
}

// ---- App ---------------------------------------------------------------------

function App({ store, controller }: { store: UiStore; controller: TerminalUi }): React.JSX.Element {
  const state = useSyncExternalStore(store.subscribe, store.get);
  const { columns, rows } = useWindowSize();
  useInput((input, key) => controller.handleKey(input, key));

  const cols = Math.max(1, columns || 80);
  const maxRows = Math.max(3, rows || DEFAULT_HEIGHT);
  const contentWidth = Math.max(1, cols - 2);

  const allLines = useMemo(
    () => transcriptLines(state.transcript, contentWidth),
    [state.transcript, contentWidth],
  );

  const approvalBlock = state.approval
    ? approvalLines(state.approval, contentWidth, Math.max(1, maxRows - 3)).slice(-(maxRows - 3))
    : [];
  const commandMenu = controller.commandMenu(state.input);
  const reserve = 3; // header + input + status
  const menuCapacity = Math.max(0, Math.min(8, maxRows - reserve - 1));
  const commandSpace = commandMenu.visible
    ? Math.min(menuCapacity, commandMenu.items.length)
    : 0;
  const approvalSpace = approvalBlock.length;
  const viewport = Math.max(0, maxRows - reserve - approvalSpace - commandSpace);

  // 视口计算：从底部向上取 viewport 行；scrollFromBottom 大于 0 时向上偏移，
  // 并把“上方还有内容”的提示行挤掉一行，避免提示行把正文顶出屏幕。
  const scrollFromBottom = Math.min(state.scrollFromBottom, Math.max(0, allLines.length - viewport));
  const start = Math.max(0, allLines.length - viewport - scrollFromBottom);
  const hasMoreAbove = start > 0;
  const usable = Math.max(0, viewport - (hasMoreAbove ? 1 : 0));
  const slice = allLines.slice(start, start + usable);
  const banner: Line[] = hasMoreAbove
    ? [{ key: 'scroll-up', segments: [{ text: ` ↑ 还有 ${start} 行 · Shift+↑ 上翻 / Shift+↓ 回底部`, color: DIM }] }]
    : [];

  const renderLine = (line: Line): React.JSX.Element => (
    <Text key={line.key} wrap="truncate">
      {line.segments.map((segment, i) => (
        <Text key={i} color={segment.color} dimColor={segment.dim || undefined} bold={segment.bold}>
          {segment.text}
        </Text>
      ))}
    </Text>
  );

  if (state.confirmation) {
    return (
      <Box flexDirection="column" width={cols}>
        <Text color={WARN}>{state.confirmation.message}</Text>
        <Text color={WARN}>确认删除？y / N</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" width={cols} height={maxRows}>
      <Box height={1} overflow="hidden"><Header state={state} /></Box>
      <Box height={viewport} flexDirection="column" overflow="hidden">
        {banner.map(renderLine)}
        {slice.map(renderLine)}
      </Box>
      {approvalBlock.length > 0
        ? (
            <Box flexDirection="column">
              {approvalBlock.map(renderLine)}
            </Box>
          )
        : null}
      {commandMenu.visible ? <CommandMenu items={commandMenu.items} selected={commandMenu.selected} width={contentWidth} capacity={menuCapacity} /> : null}
      <PromptLine state={state} width={cols} />
      <Box height={1} overflow="hidden"><StatusBar state={state} compact={cols < 110} /></Box>
    </Box>
  );
}

// ---- TerminalUi --------------------------------------------------------------

function cleanDisplayText(value: string): string {
  return value
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, '');
}

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

export function inputViewport(before: string, after: string, width: number): { before: string; after: string } {
  const segments = [...graphemes.segment(before)].map((item) => item.segment);
  let used = 0;
  let start = segments.length;
  while (start > 0 && used + stringWidth(segments[start - 1]!) <= width - 1) {
    used += stringWidth(segments[--start]!);
  }
  return { before: segments.slice(start).join(''), after: width - used > 1 ? truncateDisplayText(after, width - used - 1) : '' };
}

function adjacentCursor(input: string, cursor: number, direction: -1 | 1): number {
  const boundaries = [...graphemes.segment(input)].map((item) => item.index).concat(input.length);
  return direction < 0 ? boundaries.findLast((index) => index < cursor) ?? 0
    : boundaries.find((index) => index > cursor) ?? input.length;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function toolStatusLabel(status: ToolExecutionStatus): { label: string; color: string } {
  switch (status) {
    case 'ok': return { label: 'ok', color: GOOD };
    case 'denied': return { label: 'denied', color: BAD };
    case 'invalid': return { label: 'invalid', color: BAD };
    case 'timeout': return { label: 'timeout', color: WARN };
    case 'cancelled': return { label: 'cancelled', color: DIM };
    case 'failed': return { label: 'failed', color: BAD };
  }
}

function compactToolDetail(result?: { summary?: string; output?: { content?: string } }): string {
  const summary = result?.summary?.trim();
  if (summary) return truncateDisplayText(summary.replace(/\n/g, ' '), 200);
  const content = result?.output?.content;
  if (content) return truncateDisplayText(content.replace(/\n/g, ' '), 200);
  return '';
}

/** 依赖 Ink/React 的对话式全屏终端界面，复用现有 Session/Runtime，不改变 Agent 协议。 */
export class TerminalUi {
  private readonly store: UiStore;
  private readonly seq: { value: number } = { value: 0 };
  private activeAbort?: AbortController;
  private exitResolver?: () => void;
  private inkInstance?: ReturnType<typeof render>;
  private deltaBuffer = '';
  private deltaTimer?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private completionGeneration = 0;
  private completionTimer?: ReturnType<typeof setTimeout>;

  constructor(private readonly options: TuiOptions) {
    this.store = new UiStore({
      transcript: [],
      busy: false,
      status: '就绪',
      statusTone: 'info',
      input: '',
      inputCursor: 0,
      historyDraft: '',
      argumentInput: '',
      argumentCandidates: [],
      history: [],
      historyIndex: -1,
      scrollFromBottom: 0,
      tokens: 0,
      maxContext: options.maxContextTokens,
      model: options.model,
      route: options.route,
      privacy: options.privacy,
      workspaceRoot: options.workspaceRoot,
      sessionId: options.sessionId,
      commandMenuSelection: 0,
      commandMenuDismissed: false,
    });
  }

  commandMenu(input: string): {
    visible: boolean;
    items: readonly MenuCandidate[];
    selected: number;
  } {
    const state = this.store.get();
    const items: MenuCandidate[] = filterCommandCandidates(input, this.catalogContext());
    if (items.length === 0 && state.argumentInput === input && !state.busy) items.push(...state.argumentCandidates);
    const selected = Math.min(state.commandMenuSelection, Math.max(0, items.length - 1));
    return {
      visible: !state.commandMenuDismissed && !state.approval && !state.confirmation && items.length > 0,
      items,
      selected,
    };
  }

  private catalogContext() {
    return {
      workspaceAvailable: Boolean(this.options.workspaceCommands),
      backgroundTasksAvailable: Boolean(this.options.backgroundTasks),
      sessionDeletionAvailable: Boolean(this.options.deleteSession),
      busy: this.store.get().busy,
      interface: 'tui' as const,
    };
  }

  view(): React.JSX.Element {
    return <App store={this.store} controller={this} />;
  }

  async start(): Promise<void> {
    if (!stdin.isTTY || !stdout.isTTY || !stdin.setRawMode) {
      throw new Error('当前终端不支持 TUI，请使用交互式终端运行');
    }
    // 进入备用屏幕缓冲区并隐藏光标；渲染或事件处理抛错时 finally 仍会恢复终端。
    stdout.write('\u001b[?1049h\u001b[?25l');
    try {
      for (const [prefix, value] of [
        ['workspace ', this.options.workspaceRoot],
        ['session ', this.options.sessionId],
      ] as const) {
        this.pushNotice(`${prefix}${value}`, 'dim');
      }
      for (const message of this.options.startupMessages ?? []) this.pushNotice(message, 'info');
      this.store.update((s) => ({ ...s, status: '就绪' }));
      // exitOnCtrlC: false——Ctrl+C 由 handleKey 自行解释（有活动 Turn 时只取消 Turn）。
      this.inkInstance = render(this.view(), { exitOnCtrlC: false });
      await new Promise<void>((resolve) => {
        this.exitResolver = resolve;
      });
    } finally {
      this.exitResolver = undefined;
      try {
        this.inkInstance?.unmount();
      } finally {
        this.inkInstance = undefined;
        stdout.write('\u001b[?25h\u001b[?1049l\n');
      }
    }
  }

  async requestApproval(request: ApprovalRequest): Promise<ApprovalDecision> {
    let preview: ApprovalPreview | undefined;
    if (request.toolName === 'apply_patch' || request.toolName === 'apply_sandbox_patch') {
      try {
        preview = await previewApprovalRequest(request);
      } catch (error) {
        // 预览失败按拒绝处理：不能因为拿不到 diff 就放行一个用户没看过的改动。
        this.pushNotice(`Patch 预览失败：${message(error)}`, 'error');
        return { decision: 'deny', scope: 'once', decidedAt: new Date().toISOString(), reason: 'Patch 预览失败' };
      }
    }
    const approval: ApprovalUi = {
      request,
      stage: 'decision',
      preview,
      resolve: () => undefined,
    };
    this.store.update((s) => ({
      ...s,
      approval,
      status: `需要审批：${request.toolName}`,
      statusTone: 'warn',
    }));
    // 返回的 Promise 由用户按键决定何时 resolve；期间 TUI 停留在审批界面。
    return new Promise<ApprovalDecision>((resolve) => {
      const current = this.store.get();
      if (current.approval) current.approval.resolve = resolve;
    });
  }

  notify(message: string): void {
    this.pushNotice(message, 'info');
  }

  // 按键分发：审批界面优先于一切普通输入；滚动键独立于输入框；其余才落到输入编辑。
  handleKey(input: string, key: Key): void {
    const state = this.store.get();
    if (state.confirmation) {
      const confirmed = !key.ctrl && !key.meta && input.toLowerCase() === 'y';
      if (confirmed || input.toLowerCase() === 'n' || key.escape || key.return || (key.ctrl && ['c', 'd'].includes(input))) {
        this.store.update((s) => ({ ...s, confirmation: undefined }));
        state.confirmation.resolve(confirmed);
      }
      return;
    }
    if (state.approval) {
      this.handleApprovalKey(input, key);
      return;
    }
    if (key.shift && key.upArrow) {
      this.store.update((s) => ({ ...s, scrollFromBottom: s.scrollFromBottom + 4 }));
      return;
    }
    if (key.shift && key.downArrow) {
      this.store.update((s) => ({ ...s, scrollFromBottom: Math.max(0, s.scrollFromBottom - 4) }));
      return;
    }
    if (key.pageUp) {
      this.store.update((s) => ({ ...s, scrollFromBottom: s.scrollFromBottom + 16 }));
      return;
    }
    if (key.pageDown) {
      this.store.update((s) => ({ ...s, scrollFromBottom: Math.max(0, s.scrollFromBottom - 16) }));
      return;
    }
    if (key.ctrl && input === 'c') {
      if (this.activeAbort && !this.activeAbort.signal.aborted) {
        this.activeAbort.abort('user_cancelled');
        this.store.update((s) => ({ ...s, status: '正在取消当前 Turn...', statusTone: 'warn' }));
      } else {
        this.quit();
      }
      return;
    }
    if (key.ctrl && input === 'd') {
      this.quit();
      return;
    }
    const menu = this.commandMenu(state.input);
    if (menu.visible && key.escape) {
      this.store.update((s) => ({ ...s, commandMenuDismissed: true }));
      return;
    }
    if (menu.visible && key.upArrow) {
      this.store.update((s) => ({
        ...s,
        commandMenuSelection: Math.max(0, Math.min(menu.items.length - 1, s.commandMenuSelection - 1)),
      }));
      return;
    }
    if (menu.visible && key.downArrow) {
      this.store.update((s) => ({
        ...s,
        commandMenuSelection: Math.min(menu.items.length - 1, s.commandMenuSelection + 1),
      }));
      return;
    }
    if (key.tab && menu.items.length > 0) {
      if (menu.visible) this.completeSelectedCommand(menu);
      else this.store.update((s) => ({ ...s, commandMenuDismissed: false }));
      return;
    }
    if (key.return) {
      if (menu.visible && this.confirmSelectedCommand(menu)) return;
      void this.submit();
      return;
    }
    if (key.upArrow) {
      this.history(-1);
      return;
    }
    if (key.downArrow) {
      this.history(1);
      return;
    }
    if (key.leftArrow || key.rightArrow || key.home || key.end || (key.ctrl && (input === 'a' || input === 'e'))) {
      const cursor = key.ctrl || key.home || key.end ? (key.home || input === 'a' ? 0 : state.input.length)
        : adjacentCursor(state.input, state.inputCursor, key.leftArrow ? -1 : 1);
      this.store.update((s) => ({ ...s, inputCursor: cursor, commandMenuDismissed: true }));
      return;
    }
    if (key.backspace || key.delete) {
      const start = key.backspace ? adjacentCursor(state.input, state.inputCursor, -1) : state.inputCursor;
      const end = key.backspace ? state.inputCursor : adjacentCursor(state.input, state.inputCursor, 1);
      this.setInput(state.input.slice(0, start) + state.input.slice(end), start);
      return;
    }
    // 过滤控制字符：raw mode 下组合键会产生转义序列，只有可打印字符才进输入框。
    if (input && !key.meta && !key.ctrl) {
      input = input.replace(/\r\n?/gu, '\n');
      const printable = [...input].every((character) => (character >= ' ' && character !== '') || character === '\n' || character === '\t');
      if (printable) {
        // 20_000 字符上限：防止粘贴超长内容把 TUI 渲染拖垮。
        const inserted = input.slice(0, Math.max(0, 20000 - state.input.length));
        this.setInput(state.input.slice(0, state.inputCursor) + inserted + state.input.slice(state.inputCursor), state.inputCursor + inserted.length);
      }
    }
  }

  private setInput(input: string, cursor = input.length): void {
    this.store.update((s) => ({
      ...s,
      input,
      inputCursor: cursor,
      argumentInput: '',
      argumentCandidates: [],
      commandMenuSelection: 0,
      commandMenuDismissed: false,
    }));
    this.refreshArguments(input);
  }

  private refreshArguments(input: string): void {
    const generation = ++this.completionGeneration;
    clearTimeout(this.completionTimer);
    const token = input.trimStart().split(/\s/u)[0]?.toLowerCase();
    const descriptor = getCommandCatalog(this.catalogContext()).find((item) => item.name === token || item.aliases?.includes(token ?? ''));
    if (!descriptor?.acceptsArguments || !/\s/u.test(input.trimStart())) return;
    const state = this.store.get();
    this.completionTimer = setTimeout(() => {
      void completeArguments(input, {
        workspaceRoot: state.workspaceRoot,
        currentSessionId: state.sessionId,
        listSessions: this.options.listSessions,
        listTasks: this.options.backgroundTasks ? () => this.options.backgroundTasks!.list() : undefined,
      }).then((candidates) => {
        if (this.stopped || generation !== this.completionGeneration || this.store.get().input !== input) return;
        this.store.update((s) => ({ ...s, argumentInput: input,
          argumentCandidates: candidates.map((candidate) => ({ ...descriptor, ...candidate, usage: candidate.name })),
        }));
      }).catch(() => undefined);
    }, 60);
    this.completionTimer.unref();
  }

  private completeSelectedCommand(menu: { items: readonly MenuCandidate[]; selected: number }): void {
    const command = menu.items[menu.selected];
    if (!command) return;
    this.setInput(command.replacement ?? completeCommand(this.store.get().input, command));
    if (command.replacement) this.store.update((s) => ({ ...s, commandMenuDismissed: true }));
  }

  private confirmSelectedCommand(menu: { items: readonly MenuCandidate[]; selected: number }): boolean {
    const command = menu.items[menu.selected];
    if (!command) return false;
    const currentInput = this.store.get().input;
    this.setInput(command.replacement ?? completeCommand(currentInput, command));
    if (command.replacement) this.store.update((s) => ({ ...s, commandMenuDismissed: true }));
    if (!command.acceptsArguments && !command.replacement) void this.submit();
    return true;
  }

  private handleApprovalKey(input: string, key: Key): void {
    const approval = this.store.get().approval;
    if (!approval) return;
    if (key.escape || (key.ctrl && ['c', 'd'].includes(input))) {
      this.resolveApproval({ decision: 'deny', scope: 'once', decidedAt: new Date().toISOString(), reason: '用户取消审批' });
      if (key.ctrl) this.activeAbort?.abort('user_cancelled');
      return;
    }
    const char = input.toLowerCase();
    if (approval.stage === 'decision') {
      if (char === 'n' || key.escape || input === '\u001b') {
        this.resolveApproval({ decision: 'deny', scope: 'once', decidedAt: new Date().toISOString(), reason: '用户拒绝' });
      } else if (char === 'y') {
        this.store.update((s) => ({
          ...s,
          approval: s.approval ? { ...s.approval, stage: 'scope' } : undefined,
          status: '已允许，选择记忆范围',
          statusTone: 'info',
        }));
      }
      return;
    }
    const scopes: Record<string, ApprovalDecision['scope']> = {
      '1': 'once', '2': 'session', '3': 'project', '4': 'persistent',
    };
    const scope = scopes[char];
    if (scope) this.resolveApproval({ decision: 'allow', scope, decidedAt: new Date().toISOString(), reason: '用户已批准' });
  }

  private resolveApproval(decision: ApprovalDecision): void {
    const approval = this.store.get().approval;
    this.store.update((s) => ({
      ...s,
      approval: undefined,
      status: decision.decision === 'allow' ? '审批通过，继续执行' : '审批拒绝',
      statusTone: decision.decision === 'allow' ? 'success' : 'warn',
    }));
    approval?.resolve(decision);
  }

  private history(direction: number): void {
    const state = this.store.get();
    if (state.history.length === 0) return;
    let index = state.historyIndex < 0 ? state.history.length : state.historyIndex;
    index = Math.min(Math.max(0, index + direction), state.history.length);
    const draft = state.historyIndex < 0 ? state.input : state.historyDraft;
    const value = index === state.history.length ? draft : state.history[index] ?? '';
    this.setInput(value);
    this.store.update((s) => ({
      ...s,
      historyIndex: index === state.history.length ? -1 : index,
      input: value,
      historyDraft: draft,
      commandMenuSelection: 0,
      commandMenuDismissed: false,
    }));
  }

  private async submit(): Promise<void> {
    const state = this.store.get();
    if (!state.input.trim()) return;
    const parsed = parseCommandInput(state.input, this.catalogContext());
    if (parsed.error) { this.pushNotice(parsed.error, 'warn'); return; }
    const prompt = parsed.input;
    if (state.busy && (!this.activeAbort || !prompt.startsWith('/steer '))) {
      this.pushNotice('当前操作尚未结束；运行中的补充要求请使用 /steer <要求>。', 'warn');
      return;
    }
    this.setInput('');
    // 历史只保留最近 100 条，防止长会话里历史列表无限增长。
    this.store.update((s) => ({
      ...s,
      input: '',
      inputCursor: 0,
      historyDraft: '',
      argumentInput: '',
      argumentCandidates: [],
      history: [...s.history, prompt].slice(-100),
      historyIndex: -1,
      commandMenuSelection: 0,
      commandMenuDismissed: false,
    }));
    this.pushUser(prompt);

    if (state.busy) {
      try {
        await this.options.steer(prompt.slice('/steer '.length));
        this.pushNotice('补充要求已排队，将在下一模型步骤消费；若本轮已结束可用 /resume 继续。', 'info');
      } catch (error) { this.pushNotice(message(error), 'error'); }
      return;
    }

    if (prompt === '/exit' || prompt === '/quit') {
      this.quit();
      return;
    }
    if (prompt === '/help') {
      for (const line of formatCommandHelp(this.catalogContext())) this.pushNotice(line, 'info');
      return;
    }
    if (isWorkspaceCommand(prompt)) {
      if (!this.options.workspaceCommands) {
        this.pushNotice('工作目录切换服务不可用。', 'warn');
        return;
      }
      await this.runTask('正在处理工作目录...', async () => {
        const result = await executeWorkspaceCommand(prompt, this.options.workspaceCommands!);
        if (result.workspace) {
          this.store.update((s) => ({
            ...s,
            workspaceRoot: result.workspace!.workspaceRoot,
            sessionId: result.workspace!.sessionId,
            tokens: 0,
          }));
        }
        for (const line of result.lines) {
          const tone: Tone = line.startsWith('警告：')
            ? 'warn'
            : result.workspace?.changed && line.startsWith('工作目录已切换：')
              ? 'success'
              : 'info';
          this.pushNotice(line, tone);
        }
      });
      return;
    }
    if (isBackgroundTaskCommand(prompt)) {
      if (!this.options.backgroundTasks) {
        this.pushNotice('后台任务服务不可用。', 'warn');
        return;
      }
      await this.runTask('正在处理后台任务...', async () => {
        const result = await executeBackgroundTaskCommand(prompt, this.options.backgroundTasks!);
        for (const line of result.lines) this.pushNotice(line, 'info');
      });
      return;
    }
    if (prompt === '/clear') {
      this.store.update((s) => ({ ...s, transcript: [], scrollFromBottom: 0 }));
      return;
    }
    if (prompt === '/sessions' || prompt === '/session' || prompt.startsWith('/session ')) {
      await this.runTask('正在读取会话...', async () => {
        const lines = await executeSessionCommand(prompt, {
          currentSessionId: state.sessionId,
          list: this.options.listSessions,
          delete: async (session) => {
            if (!this.options.deleteSession) throw new Error('会话删除服务不可用');
            await this.options.deleteSession(session);
          },
          confirm: (text) => this.confirmDeletion(text),
        });
        for (const line of lines) this.pushNotice(line, 'info');
      });
      return;
    }
    if (prompt === '/verify') {
      await this.runTask('正在验证...', async () => {
        const results = await this.options.verify();
        for (const result of results) this.pushNotice(`${result.id}: ${result.status} - ${result.summary}`, 'info');
      });
      return;
    }
    if (prompt === '/rollback' || prompt.startsWith('/rollback ')) {
      const id = prompt.split(/\s+/u)[1];
      if (!id || prompt.split(/\s+/u).length !== 2) {
        this.pushNotice('用法：/rollback <checkpoint-id>', 'warn');
        return;
      }
      await this.runTask(`正在回滚 ${id}...`, async () => {
        const result = await this.options.rollback(await this.options.loadCheckpoint(id));
        this.pushNotice(`已恢复 ${result.restoredPaths.length} 个文件`, 'success');
        for (const skipped of result.skippedPaths) this.pushNotice(`跳过后续修改：${skipped}`, 'warn');
      });
      return;
    }
    if (prompt === '/steer') {
      this.pushNotice('用法：/steer <要求>', 'warn');
      return;
    }
    if (prompt.startsWith('/steer ')) {
      await this.runAgent(prompt, true, prompt.slice('/steer '.length));
      return;
    }
    await this.runAgent(prompt, prompt === '/resume');
  }

  private confirmDeletion(text: string): Promise<boolean> {
    if (this.stopped) return Promise.resolve(false);
    this.pushNotice(text, 'warn');
    return new Promise((resolve) => this.store.update((s) => ({
      ...s, scrollFromBottom: 0, confirmation: { message: text, resolve },
    })));
  }

  private async runAgent(prompt: string, resume: boolean, steering?: string): Promise<void> {
    if (this.store.get().busy) return;
    this.store.update((s) => ({
      ...s,
      busy: true,
      status: resume ? '恢复运行中' : '运行中',
      statusTone: 'info',
    }));
    this.activeAbort = new AbortController();
    try {
      if (steering) await this.options.steer(steering);
      const result = resume
        ? await this.options.resume(this.activeAbort.signal, (event) => this.onEvent(event))
        : await this.options.run(prompt, this.activeAbort.signal, (event) => this.onEvent(event));
      this.flushDelta();
      this.finishAssistant(
        result.answer,
        result.finalSummary.verified ? result.finalSummary.value : undefined,
      );
      this.store.update((s) => ({
        ...s,
        status: `${result.state} | turn=${result.turnId}`,
        statusTone: result.state === 'completed' ? 'success' : 'warn',
      }));
    } catch (error) {
      this.flushDelta();
      this.store.update((s) => ({ ...s, status: '运行失败', statusTone: 'error' }));
      this.pushNotice(message(error), 'error');
    } finally {
      this.activeAbort = undefined;
      this.store.update((s) => ({ ...s, busy: false }));
    }
  }

  private async runTask(label: string, task: () => Promise<void>): Promise<void> {
    if (this.store.get().busy) return;
    this.store.update((s) => ({ ...s, busy: true, status: label, statusTone: 'info' }));
    try {
      await task();
      this.store.update((s) => ({ ...s, status: '就绪', statusTone: 'info' }));
    } catch (error) {
      this.pushNotice(message(error), 'error');
      this.store.update((s) => ({ ...s, status: '操作失败', statusTone: 'error' }));
    } finally {
      this.store.update((s) => ({ ...s, busy: false }));
    }
  }

  private finishAssistant(answer: string, summary?: FinalSummary): void {
    this.store.update((s) => {
      const transcript = [...s.transcript];
      // Replace the most-recent assistant item. Skip trailing notices that were
      // inserted after the model produced its final answer (e.g. a verification
      // notice in the same turn) so we don't append a duplicate assistant block.
      let index = -1;
      for (let i = transcript.length - 1; i >= 0; i -= 1) {
        const item = transcript[i];
        if (!item) continue;
        if (item.kind === 'assistant') {
          index = i;
          break;
        }
        if (item.kind === 'tool' || item.kind === 'user' || item.kind === 'patch') break;
      }
      const last = index >= 0 ? transcript[index] : undefined;
      if (last?.kind === 'assistant') {
        transcript[index] = { ...last, text: answer || last.text, streaming: false, summary };
      } else if (answer.trim()) {
        transcript.push({ kind: 'assistant', id: this.nid(), text: answer, streaming: false, summary });
      }
      return { ...s, transcript };
    });
  }

  private onEvent(event: AgentEvent): void {
    const payload = event.payload;
    if (payload.type === 'model.output.delta') {
      this.deltaBuffer += cleanDisplayText(payload.delta);
      this.scheduleFlush();
      return;
    }
    this.flushDelta();
    switch (payload.type) {
      case 'turn.started':
        break;
      case 'run.started':
        break;
      case 'model.started':
        this.store.update((s) => ({ ...s, status: `模型步骤 ${payload.step + 1}`, statusTone: 'info' }));
        break;
      case 'model.completed':
        this.store.update((s) => ({ ...s, status: `模型步骤 ${payload.step + 1} 完成`, statusTone: 'info' }));
        break;
      case 'model.retry':
        this.pushNotice(`模型重试 ${payload.attempt}：${payload.code}`, 'warn');
        break;
      case 'model.failed':
        this.pushNotice(`模型失败：${payload.code}`, 'error');
        break;
      case 'tool.started': {
        this.closeAssistant();
        const { callId, toolName } = payload;
        this.store.update((s) => {
          const transcript = [...s.transcript];
          const index = transcript.findIndex((item) => item.kind === 'tool' && item.callId === callId);
          const tool: ViewItem = { kind: 'tool', id: this.nid(), callId, toolName, streaming: true };
          if (index >= 0) transcript[index] = tool;
          else transcript.push(tool);
          return { ...s, transcript, status: `工具 ${toolName} 运行中`, statusTone: 'info' };
        });
        break;
      }
      case 'tool.progress':
        this.store.update((s) => ({
          ...s,
          status: `工具 ${payload.toolName}：${payload.total ? `${payload.progress}/${payload.total}` : payload.progress}`,
          statusTone: 'info',
        }));
        break;
      case 'tool.completed': {
        const { callId, toolName, status, elapsedMs, result } = payload;
        const { label, color } = toolStatusLabel(status);
        const detail = compactToolDetail(result);
        this.store.update((s) => {
          const transcript = [...s.transcript];
          const index = transcript.findIndex((item) => item.kind === 'tool' && item.callId === callId);
          const tool: ViewItem = {
            kind: 'tool', id: this.nid(), callId, toolName,
            streaming: false, status: label, statusColor: color, elapsedMs, detail: detail || undefined,
          };
          if (index >= 0) transcript[index] = tool;
          else transcript.push(tool);
          return { ...s, transcript, status: `工具 ${toolName} ${label}`, statusTone: label === 'ok' ? 'success' : 'warn' };
        });
        break;
      }
      case 'approval.requested':
        this.store.update((s) => ({ ...s, status: `等待审批：${payload.permission}`, statusTone: 'warn' }));
        break;
      case 'approval.decided':
        this.pushNotice(`审批：${payload.decision}（${payload.scope}）`, payload.decision === 'allow' ? 'success' : 'warn');
        break;
      case 'usage.recorded':
        this.store.update((s) => ({ ...s, tokens: payload.usage.inputTokens + payload.usage.outputTokens }));
        break;
      case 'verification.completed':
        if (!payload.verified) this.pushNotice(`结构化结果未验证，发现 ${payload.issueCount} 个问题`, 'warn');
        break;
      case 'run.completed':
        break;
      case 'run.paused':
        this.pushNotice(`已暂停：${payload.reason}`, 'warn');
        break;
      case 'run.cancelled':
        this.pushNotice(`已取消：${payload.reason}`, 'warn');
        break;
      case 'run.failed':
        this.pushNotice(`运行失败：${payload.code}`, 'error');
        break;
      case 'checkpoint.saved':
      case 'guardrail.decision':
      case 'workspace.file.observed':
      case 'session.created':
      case 'turn.steered':
        break;
    }
  }

  private closeAssistant(): void {
    this.flushDelta();
    this.store.update((s) => {
      const transcript = [...s.transcript];
      const last = transcript[transcript.length - 1];
      if (last && last.kind === 'assistant' && last.streaming) {
        transcript[transcript.length - 1] = { ...last, streaming: false };
      }
      return { ...s, transcript };
    });
  }

  // delta 合并到 16ms 一帧再刷新：模型流式输出频率远高于渲染频率，逐条更新
  // 会让 React 每毫秒都重渲染，合并后既保证观感连续，也避免 CPU 空转。
  private scheduleFlush(): void {
    if (this.deltaTimer) return;
    this.deltaTimer = setTimeout(() => {
      this.deltaTimer = undefined;
      this.flushDelta();
    }, 16);
  }

  private flushDelta(): void {
    if (this.deltaTimer) {
      clearTimeout(this.deltaTimer);
      this.deltaTimer = undefined;
    }
    const text = this.deltaBuffer;
    this.deltaBuffer = '';
    if (!text) return;
    this.store.update((s) => {
      const transcript = [...s.transcript];
      const last = transcript[transcript.length - 1];
      // 追加到正在流式的 assistant 条目；没有流式条目（例如事件顺序异常）时新建一条。
      if (last && last.kind === 'assistant' && last.streaming) {
        transcript[transcript.length - 1] = { ...last, text: last.text + text };
      } else {
        transcript.push({ kind: 'assistant', id: this.nid(), text, streaming: true });
      }
      return { ...s, transcript };
    });
  }

  private pushUser(text: string): void {
    this.store.update((s) => ({ ...s, transcript: [...s.transcript, { kind: 'user', id: this.nid(), text }] }));
  }

  private pushNotice(text: string, tone: Tone): void {
    this.store.update((s) => ({
      ...s,
      transcript: [...s.transcript, { kind: 'notice', id: this.nid(), text, tone }],
      status: tone === 'error' ? text : s.status,
      statusTone: tone === 'error' ? 'error' : s.statusTone,
    }));
  }

  private nid(): string {
    this.seq.value += 1;
    return `v${this.seq.value}`;
  }

  // stopped 防重入：quit 可能被 Ctrl+C、Ctrl+D、/exit 多次触发，第二次直接忽略。
  private quit(): void {
    if (this.stopped) return;
    this.stopped = true;
    clearTimeout(this.completionTimer);
    this.completionGeneration += 1;
    // 退出即取消活动 Turn；挂起的审批按拒绝结算，避免调用方永远等不到决定。
    this.activeAbort?.abort('user_exit');
    const state = this.store.get();
    state.confirmation?.resolve(false);
    if (state.approval) {
      this.store.update((s) => ({ ...s, approval: undefined }));
      state.approval.resolve({
        decision: 'deny',
        scope: 'once',
        decidedAt: new Date().toISOString(),
        reason: 'TUI 已退出',
      });
    }
    this.exitResolver?.();
  }
}
