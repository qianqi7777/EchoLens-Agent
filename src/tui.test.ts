import assert from 'node:assert/strict';
import test from 'node:test';
import stringWidth from 'string-width';
import { truncateDisplayText, wrapDisplayText } from './tui.js';

test('TUI 按终端列宽换行中文和无空格长文本', () => {
  const lines = wrapDisplayText('继续执行后请检查结构化结果与checkpoint-id', 12);

  assert.ok(lines.length > 1);
  assert.equal(lines.every((line) => stringWidth(line) <= 12), true);
  assert.equal(lines.join(''), '继续执行后请检查结构化结果与checkpoint-id');
});

test('TUI 截断中文路径时不超过终端列宽', () => {
  const value = truncateDisplayText('D:\\项目\\EchoLens-Agent', 14);

  assert.equal(stringWidth(value) <= 14, true);
  assert.equal(value.endsWith('…'), true);
});
