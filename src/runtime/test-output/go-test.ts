import type { ParsedFailure } from './index.js';
import { failure, locationFrom } from './shared.js';

export const goTestParser = {
  format: 'go-test',
  detect(raw: string): boolean {
    return /^--- FAIL:\s|^FAIL(?:\s|$)|^\{"Action":"(?:run|fail|output|pass)"/mu.test(raw);
  },
  parse(raw: string): ParsedFailure[] {
    const jsonEvents = raw.split(/\r?\n/u).flatMap((line) => {
      try { return [JSON.parse(line) as { Action?: string; Test?: string; Output?: string }]; } catch { return []; }
    });
    if (jsonEvents.length) {
      const failedTests = new Set(jsonEvents.filter((event) => event.Action === 'fail' && event.Test).map((event) => event.Test!));
      return [...failedTests].map((testName) => {
        const output = jsonEvents.filter((event) => event.Action === 'output' && event.Test === testName)
          .map((event) => event.Output ?? '').join('').trim();
        const detail = output.split(/\r?\n/u).find((line) => /\.go:\d+:/u.test(line));
        const message = /^\s*(.+\.go:\d+):\s?(.*)$/u.exec(detail ?? '');
        return failure({
          testName,
          ...locationFrom(message?.[1] ?? output),
          message: message?.[2] || output || 'Go test failed',
          ...(output ? { stack: output } : {}),
        });
      });
    }
    const lines = raw.split(/\r?\n/u);
    const failures: ParsedFailure[] = [];
    let testName: string | undefined;
    for (const line of lines) {
      const header = /^--- FAIL:\s+(\S+)/u.exec(line);
      if (header) testName = header[1];
      const detail = /^\s+(.+\.go:\d+):\s?(.*)$/u.exec(line);
      if (detail) failures.push(failure({ testName, ...locationFrom(detail[1]!), message: detail[2] || 'Go test failed' }));
    }
    if (!failures.length && testName) failures.push(failure({ testName, message: 'Go test failed' }));
    return failures;
  },
};
