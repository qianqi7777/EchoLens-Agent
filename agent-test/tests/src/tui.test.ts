import assert from 'node:assert/strict';
import test from 'node:test';
import stringWidth from 'string-width';
import { inputViewport, TerminalUi, truncateDisplayText, wrapDisplayText, type TuiOptions } from '../../../src/tui.js';
import { render, type Key } from 'ink';
import { PassThrough, Writable } from 'node:stream';
import { stripVTControlCharacters } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';

const result = { answer: 'done', state: 'completed', turnId: 'turn', finalSummary: { verified: false } } as Awaited<ReturnType<TuiOptions['run']>>;

function createUi(overrides: Partial<TuiOptions> = {}) {
  return new TerminalUi({
    model: 'mock', route: 'local', sessionId: 'active', workspaceRoot: process.cwd(),
    run: async () => result, resume: async () => result, steer: async () => undefined,
    listSessions: async () => [{ sessionId: 'old', modifiedAt: 'date', bytes: 1 }],
    verify: async () => [], rollback: async () => ({ restoredPaths: [], skippedPaths: [] }),
    loadCheckpoint: async () => { throw new Error('not found'); },
    ...overrides,
  });
}

function key(ui: TerminalUi, input = '', flags: Partial<Key> = {}) {
  ui.handleKey(input, flags as Key);
}

async function idle(ui: TerminalUi) {
  for (let i = 0; i < 100 && ui['store'].get().busy; i++) await delay(5);
  assert.equal(ui['store'].get().busy, false);
}

test('TUI Enter 一次执行部分匹配的无参数命令，Tab 不执行，Esc 保留输入', async () => {
  let lists = 0;
  const ui = createUi({ listSessions: async () => { lists++; return []; } });
  key(ui, '/sess');
  key(ui, '', { tab: true });
  assert.equal(lists, 0);
  assert.equal(ui['store'].get().input, '/sessions');
  key(ui, '', { return: true });
  await idle(ui);
  assert.equal(lists, 1);
  key(ui, '/sess');
  key(ui, '', { return: true });
  await idle(ui);
  assert.equal(lists, 2);
  key(ui, '/');
  key(ui, '', { escape: true });
  assert.equal(ui['store'].get().input, '/');
  assert.equal(ui.commandMenu('/').visible, false);
});

test('TUI 参数候选只补全，历史会话删除取消与确认均只结算一次', async () => {
  let deletions = 0;
  const ui = createUi({ deleteSession: async () => { deletions++; } });
  key(ui, '/session delete ');
  await delay(100);
  assert.equal(ui.commandMenu(ui['store'].get().input).items[0]?.name, 'old');
  key(ui, '', { return: true });
  assert.equal(ui['store'].get().input, '/session delete old ');
  assert.equal(deletions, 0);
  key(ui, '', { return: true });
  await delay(10);
  assert.ok(ui['store'].get().confirmation);
  key(ui, '', { return: true });
  await idle(ui);
  assert.equal(deletions, 0);
  key(ui, '/session delete old');
  key(ui, '', { return: true });
  await delay(10);
  key(ui, 'y');
  await idle(ui);
  assert.equal(deletions, 1);
  key(ui, '/session delete active');
  key(ui, '', { return: true });
  await idle(ui);
  assert.equal(deletions, 1);
});

test('TUI 编辑支持字符簇、光标、前后删除、多行粘贴和历史草稿', async () => {
  const ui = createUi();
  key(ui, '中文e\u0301');
  key(ui, '', { backspace: true });
  assert.equal(ui['store'].get().input, '中文');
  key(ui, '', { leftArrow: true });
  key(ui, '间');
  assert.equal(ui['store'].get().input, '中间文');
  key(ui, '', { delete: true });
  assert.equal(ui['store'].get().input, '中间');
  key(ui, '', { home: true });
  key(ui, '前\r\n');
  assert.equal(ui['store'].get().input, '前\n中间');
  key(ui, '', { return: true });
  await idle(ui);
  key(ui, '草稿');
  key(ui, '', { upArrow: true });
  assert.equal(ui['store'].get().input, '前\n中间');
  key(ui, '', { downArrow: true });
  assert.equal(ui['store'].get().input, '草稿');
  const viewport = inputViewport('中文'.repeat(50), 'suffix', 15);
  assert.ok(stringWidth(viewport.before + '|' + viewport.after) <= 15);
});

test('TUI 拒绝未知命令和错误参数，不向模型转发；错误后仍可执行', async () => {
  let calls = 0;
  const ui = createUi({ run: async () => { calls++; return result; }, verify: async () => { throw new Error('mock failure'); } });
  for (const input of ['/rollback-invalid id', '/verify extra', '/unknown', '/steer']) {
    ui['setInput'](input);
    await ui['submit']();
  }
  assert.equal(calls, 0);
  ui['setInput']('/verify');
  await ui['submit']();
  assert.ok(ui['store'].get().transcript.some((item) => item.kind === 'notice' && item.text === 'mock failure'));
  ui['setInput']('hello');
  await ui['submit']();
  assert.equal(calls, 1);
});

test('TUI 运行中 steering 不并发启动 Turn，暂停后 steering 会恢复', async () => {
  let finish!: (value: typeof result) => void;
  let steers = 0;
  let resumes = 0;
  const ui = createUi({
    run: () => new Promise((resolve) => { finish = resolve; }),
    steer: async () => { steers++; }, resume: async () => { resumes++; return result; },
  });
  key(ui, 'start');
  key(ui, '', { return: true });
  assert.equal(ui['store'].get().busy, true);
  assert.deepEqual(ui.commandMenu('/').items.map((item) => item.name), ['/steer']);
  key(ui, '/steer new direction');
  key(ui, '', { return: true });
  await delay(5);
  assert.equal(steers, 1);
  assert.equal(resumes, 0);
  key(ui, 'draft');
  key(ui, '', { return: true });
  assert.equal(ui['store'].get().input, 'draft');
  finish(result);
  await idle(ui);
  ui['setInput']('/steer continue');
  await ui['submit']();
  assert.equal(steers, 2);
  assert.equal(resumes, 1);
});

test('TUI 丢弃过期的异步参数候选', async () => {
  let complete!: (value: { sessionId: string; modifiedAt: string; bytes: number }[]) => void;
  const ui = createUi({ deleteSession: async () => undefined,
    listSessions: () => new Promise((resolve) => { complete = resolve; }),
  });
  ui['setInput']('/session delete ');
  await delay(100);
  ui['setInput']('/help');
  complete([{ sessionId: 'stale', modifiedAt: 'date', bytes: 1 }]);
  await delay(5);
  assert.equal(ui['store'].get().argumentCandidates.length, 0);
  assert.equal(ui.commandMenu('/help').items[0]?.name, '/help');
});

test('Ink 实际渲染在小终端和 resize 后保留选中命令，行列不溢出', async () => {
  const ui = createUi({ deleteSession: async () => undefined });
  ui['setInput']('/');
  for (let i = 0; i < 20; i++) key(ui, '', { downArrow: true });
  const frames: string[] = [];
  const output = Object.assign(new Writable({ write(chunk, _encoding, callback) { frames.push(String(chunk)); callback(); } }),
    { columns: 30, rows: 10, isTTY: true });
  const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {}, ref() {}, unref() {} });
  const app = render(ui.view(), { stdout: output as NodeJS.WriteStream, stderr: output as NodeJS.WriteStream,
    stdin: input as unknown as NodeJS.ReadStream, debug: true, patchConsole: false, exitOnCtrlC: false });
  try {
    for (const [columns, rows] of [[30, 10], [80, 24], [120, 40], [30, 10]]) {
      output.columns = columns!;
      output.rows = rows!;
      output.emit('resize');
      await app.waitUntilRenderFlush();
      await delay(30);
      const frame = stripVTControlCharacters(frames.filter((item) => item.includes('EchoLens')).at(-1) ?? '');
      assert.ok(frame.includes('/exit'), frame);
      assert.ok(frame.includes('❯'), frame);
      const lines = frame.trimEnd().split('\n');
      assert.ok(lines.length <= rows!, `height ${lines.length}/${rows}`);
      assert.ok(lines.every((line) => stringWidth(line) <= columns!), `width ${columns}: ${frame}`);
    }
  } finally {
    app.unmount();
    input.destroy();
    output.destroy();
  }
});

// 换行/截断都按显示宽度断言（string-width，中文占 2 列），而不是按字符数：
// TUI 布局错乱只会在显示宽度上暴露，charCodeAt 长度检查发现不了。
test('TUI 按终端列宽换行中文和无空格长文本', () => {
  const lines = wrapDisplayText('继续执行后请检查结构化结果与checkpoint-id', 12);

  assert.ok(lines.length > 1);
  assert.equal(lines.every((line) => stringWidth(line) <= 12), true);
  // 换行不能丢字符也不能改变顺序：内容必须与原文完全一致。
  assert.equal(lines.join(''), '继续执行后请检查结构化结果与checkpoint-id');
});

test('TUI 截断中文路径时不超过终端列宽', () => {
  const value = truncateDisplayText('D:\\项目\\EchoLens-Agent', 14);

  // 截断以省略号结尾是契约：调用方（如路径展示区）依赖它提示“内容被省略”。
  assert.equal(stringWidth(value) <= 14, true);
  assert.equal(value.endsWith('…'), true);
});
