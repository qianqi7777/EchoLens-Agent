import { cargoTestParser } from './cargo-test.js';
import { goTestParser } from './go-test.js';
import { jestParser } from './jest.js';
import { pytestParser } from './pytest.js';
import { tapParser } from './tap.js';

export interface ParsedFailure {
  file?: string;
  line?: number;
  testName?: string;
  message: string;
  stack?: string;
}

export interface TestOutputParser {
  readonly format: string;
  detect(raw: string): boolean;
  parse(raw: string): ParsedFailure[];
}

const parsers: readonly TestOutputParser[] = [tapParser, jestParser, pytestParser, goTestParser, cargoTestParser];

/** Unknown output deliberately produces no parsed details; callers retain the original output unchanged. */
export function parseTestOutput(raw: string): { format: string; failures: ParsedFailure[]; parsed: boolean } {
  const parser = parsers.find((candidate) => candidate.detect(raw));
  if (!parser) return { format: 'unknown', failures: [], parsed: false };
  try {
    const failures = parser.parse(raw);
    return { format: parser.format, failures, parsed: failures.length > 0 };
  } catch {
    // A malformed or truncated report must never hide the original command output.
    return { format: parser.format, failures: [], parsed: false };
  }
}
