import type { ParsedFailure } from './index.js';
import { failure, locationFrom } from './shared.js';

export const pytestParser = {
  format: 'pytest',
  detect(raw: string): boolean {
    return /^={3,} (?:FAILURES|short test summary info|.*\d+ failed.*) ={3,}$/mu.test(raw)
      || /^FAILED\s+\S+/mu.test(raw);
  },
  parse(raw: string): ParsedFailure[] {
    const lines = raw.split(/\r?\n/u);
    const failures: ParsedFailure[] = [];
    for (let index = 0; index < lines.length; index += 1) {
      const heading = /^_{3,}\s+(.+?)\s+_{3,}$/u.exec(lines[index]!.trim());
      if (!heading) continue;
      const section: string[] = [];
      for (let cursor = index + 1; cursor < lines.length && !/^_{3,}\s+.+\s+_{3,}$/u.test(lines[cursor]!.trim())
        && !/^={3,}\s+/u.test(lines[cursor]!.trim()); cursor += 1) section.push(lines[cursor]!);
      const detail = section.join('\n');
      const traceback = [...section].reverse().find((line) => /:\d+:\s*(?:\w+Error|AssertionError|Exception)/u.test(line));
      const location = locationFrom(traceback ?? detail);
      const summary = lines.map((line) => /^FAILED\s+(.+?)(?:\s+-\s+(.*))?$/u.exec(line))
        .find((candidate) => candidate && (candidate[1]?.includes(heading[1]!) || candidate[1]?.endsWith(`::${heading[1]}`)));
      failures.push(failure({
        ...location,
        testName: summary?.[1] ?? heading[1]!.trim(),
        message: summary?.[2] ?? traceback?.trim() ?? detail.trim() ?? 'pytest test failed',
        stack: detail,
      }));
      index += section.length;
    }
    return failures;
  },
};
