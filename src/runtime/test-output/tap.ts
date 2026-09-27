import type { ParsedFailure } from './index.js';
import { failure, locationFrom } from './shared.js';

export const tapParser = {
  format: 'tap',
  detect(raw: string): boolean {
    return /^TAP version \d+/mu.test(raw) || /^not ok \d+(?:\s|$)/mu.test(raw);
  },
  parse(raw: string): ParsedFailure[] {
    const lines = raw.split(/\r?\n/u);
    const failures: ParsedFailure[] = [];
    for (let index = 0; index < lines.length; index += 1) {
      const header = /^not ok \d+(?:\s+-\s+(.+))?$/u.exec(lines[index]!.trim());
      if (!header) continue;
      const section: string[] = [];
      for (let cursor = index + 1; cursor < lines.length && !/^(?:ok|not ok) \d+/u.test(lines[cursor]!.trim()); cursor += 1) {
        section.push(lines[cursor]!);
      }
      const detail = section.join('\n');
      const location = /location:\s*['"]([^'"\r\n]+)['"]/u.exec(detail)?.[1];
      const stack = /stack:\s*\|?-?\s*\r?\n((?:\s{2,}.+\r?\n?)+)/u.exec(detail)?.[1]
        ?.split(/\r?\n/u).map((line) => line.replace(/^\s{2}/u, '')).join('\n');
      const message = /(?:error|message):\s*(?:['"]([^'"\r\n]*)['"]|([^\r\n]+))/u.exec(detail);
      failures.push(failure({
        ...locationFrom(location ?? stack ?? ''),
        testName: header[1]?.trim(),
        message: message?.[1] ?? message?.[2] ?? 'TAP test failed',
        ...(stack ? { stack } : {}),
      }));
      index += section.length;
    }
    return failures;
  },
};
