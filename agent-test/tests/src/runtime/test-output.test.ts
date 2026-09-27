import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseTestOutput } from '../../../../src/runtime/test-output/index.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

const cases = [
  { format: 'tap', fixture: 'tap.txt', file: '/workspace/math.test.js', line: 8, testName: 'adds values', message: 'Expected 3, received 4' },
  { format: 'jest', fixture: 'jest.txt', file: 'src/math.test.ts', line: 12, testName: 'adds values', message: 'Expected: 3' },
  { format: 'pytest', fixture: 'pytest.txt', file: 'tests/test_math.py', line: 8, testName: 'tests/test_math.py::test_adds_values', message: 'assert 4 == 3' },
  { format: 'go-test', fixture: 'go-test.txt', file: 'math_test.go', line: 12, testName: 'TestAddsValues', message: 'expected 3, got 4' },
  { format: 'cargo-test', fixture: 'cargo-test.txt', file: 'src/lib.rs', line: 12, testName: 'tests::adds_values', message: "thread 'tests::adds_values' panicked at src/lib.rs:12:5:" },
] as const;

test('known test runner fixtures parse into bounded failure records', async () => {
  for (const expected of cases) {
    const raw = await readFile(path.join(root, 'agent-test/fixtures/test-output', expected.fixture), 'utf8');
    const parsed = parseTestOutput(raw);
    assert.equal(parsed.parsed, true, expected.format);
    assert.equal(parsed.format, expected.format);
    assert.equal(parsed.failures.length, 1);
    assert.equal(parsed.failures[0]?.file, expected.file);
    assert.equal(parsed.failures[0]?.line, expected.line);
    assert.equal(parsed.failures[0]?.testName, expected.testName);
    assert.equal(parsed.failures[0]?.message, expected.message);
  }
});

test('unknown or malformed output falls back without throwing and keeps the output contract', () => {
  const raw = 'custom runner: opaque failure\nsecret=do-not-parse';
  assert.deepEqual(parseTestOutput(raw), { format: 'unknown', failures: [], parsed: false });
  const malformed = parseTestOutput('TAP version 13\nnot ok 1 - broken\n  error: \'unfinished');
  assert.equal(malformed.parsed, true);
  assert.equal(malformed.failures.length, 1);
  assert.deepEqual(parseTestOutput('Test Suites: 1 failed, 1 total'), {
    format: 'jest', failures: [], parsed: false,
  });
});

test('Go package summaries are not mistaken for Jest output and JSON events aggregate by failed test', () => {
  const plain = parseTestOutput('--- FAIL: TestOne (0.00s)\n    one_test.go:7: failed\nFAIL example/pkg 0.01s');
  assert.equal(plain.format, 'go-test');
  const json = [
    { Action: 'output', Test: 'TestOne', Output: '--- FAIL: TestOne (0.00s)\n' },
    { Action: 'output', Test: 'TestOne', Output: '    one_test.go:7: expected 1, got 2\n' },
    { Action: 'fail', Test: 'TestOne' },
  ].map((event) => JSON.stringify(event)).join('\n');
  const parsed = parseTestOutput(json);
  assert.equal(parsed.failures.length, 1);
  assert.equal(parsed.failures[0]?.file, 'one_test.go');
  assert.equal(parsed.failures[0]?.message, 'expected 1, got 2');
});

test('messages and stacks are capped to prevent verification-result amplification', async () => {
  const parsed = parseTestOutput(`TAP version 13\nnot ok 1 - huge\n  error: '${'m'.repeat(2_000)}'\n  stack: |-\n${Array.from({ length: 20 }, (_, index) => `    frame-${index}`).join('\n')}`);
  assert.equal(parsed.failures[0]?.message.length, 1_000);
  assert.equal(parsed.failures[0]?.stack?.split('\n').length, 8);
});
