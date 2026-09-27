import test from 'node:test';
import assert from 'node:assert/strict';
import { headlessExitCode, headlessFailure, headlessPrompt } from '../../../src/headless.js';

test('headless prompt 与 JSON 退出码保持稳定', () => {
  assert.equal(headlessPrompt(['node', 'cli', '-p', '--prompt', '检查']), '检查');
  assert.equal(headlessExitCode({ version: 1, ok: true, state: 'completed', verified: true }), 0);
  assert.equal(headlessExitCode({ version: 1, ok: false, state: 'completed', verified: false }), 2);
  assert.equal(headlessExitCode(headlessFailure(Object.assign(new Error('denied'), { code: 'permission_denied' }))), 3);
  assert.throws(() => headlessPrompt(['node', 'cli', '--json']), /需要 --prompt/u);
});
