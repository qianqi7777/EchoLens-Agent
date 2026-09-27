import type { ParsedFailure } from './index.js';
import { failure, locationFrom } from './shared.js';

export const jestParser = {
  format: 'jest',
  detect(raw: string): boolean {
    return /^Test Suites:\s/mu.test(raw) || (/^(?:FAIL|PASS)\s+\S+/mu.test(raw) && /^\s*●\s+/mu.test(raw));
  },
  parse(raw: string): ParsedFailure[] {
    const lines = raw.split(/\r?\n/u);
    const failures: ParsedFailure[] = [];
    let file: string | undefined;
    for (let index = 0; index < lines.length; index += 1) {
      const suite = /^FAIL\s+(.+)$/u.exec(lines[index]!.trim());
      if (suite) {
        file = suite[1]?.trim();
        continue;
      }
      const name = /^\s*●\s+(.+)$/u.exec(lines[index]!);
      if (!name) continue;
      const section: string[] = [];
      for (let cursor = index + 1; cursor < lines.length && !/^\s*●\s+/u.test(lines[cursor]!); cursor += 1) section.push(lines[cursor]!);
      const block = section.join('\n').trim();
      const stackLines = section.filter((line) => /^\s+at\s/u.test(line));
      const loc = locationFrom(stackLines[0] ?? '');
      failures.push(failure({
        ...(file ? { file } : {}),
        ...loc,
        testName: name[1]!.trim(),
        message: (block.split(/\r?\n/u).find((line) => line.trim() && !/^at\s/u.test(line.trim())) ?? 'Jest test failed').trim(),
        ...(stackLines.length ? { stack: stackLines.join('\n') } : {}),
      }));
      index += section.length;
    }
    return failures;
  },
};
