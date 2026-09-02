import assert from 'node:assert/strict';
import test from 'node:test';
import stringWidth from 'string-width';
import { truncateDisplayText, wrapDisplayText } from '../../../src/tui.js';

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
