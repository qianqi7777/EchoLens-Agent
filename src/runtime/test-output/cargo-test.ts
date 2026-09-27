import type { ParsedFailure } from './index.js';
import { failure, locationFrom } from './shared.js';

export const cargoTestParser = {
  format: 'cargo-test',
  detect(raw: string): boolean {
    return /^test result:\s+FAILED/mu.test(raw) || /^---- .+ stdout ----$/mu.test(raw);
  },
  parse(raw: string): ParsedFailure[] {
    const lines = raw.split(/\r?\n/u);
    const failures: ParsedFailure[] = [];
    for (let index = 0; index < lines.length; index += 1) {
      const heading = /^---- (.+?) stdout ----$/u.exec(lines[index]!);
      if (!heading) continue;
      const section: string[] = [];
      for (let cursor = index + 1; cursor < lines.length && !/^---- .+ stdout ----$/u.test(lines[cursor]!); cursor += 1) section.push(lines[cursor]!);
      const detail = section.join('\n').trim();
      const panic = detail.match(/(?:panicked at |at )(.+?:\d+:\d+)/u)?.[1];
      failures.push(failure({
        testName: heading[1],
        ...locationFrom(panic ?? detail),
        message: detail.split(/\r?\n/u).find((line) => line.trim() && !/^stack backtrace:/u.test(line.trim()))?.trim() ?? 'Cargo test failed',
        stack: detail,
      }));
      index += section.length;
    }
    return failures;
  },
};
