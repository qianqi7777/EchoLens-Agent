import type { ParsedFailure } from './index.js';

const MESSAGE_LIMIT = 1_000;
const STACK_FRAME_LIMIT = 8;

export function failure(input: ParsedFailure): ParsedFailure {
  const message = input.message.replace(/\r\n/gu, '\n').trim().slice(0, MESSAGE_LIMIT);
  const stackLines = input.stack?.replace(/\r\n/gu, '\n').split('\n').slice(0, STACK_FRAME_LIMIT);
  return {
    ...(input.file ? { file: input.file.slice(0, 500) } : {}),
    ...(Number.isInteger(input.line) && input.line! > 0 ? { line: input.line } : {}),
    ...(input.testName ? { testName: input.testName.slice(0, 300) } : {}),
    message,
    ...(stackLines?.length ? { stack: stackLines.join('\n').slice(0, MESSAGE_LIMIT) } : {}),
  };
}

export function locationFrom(text: string): Pick<ParsedFailure, 'file' | 'line'> {
  const match = /(?:file:\/\/)?((?:[A-Za-z]:[\\/]|\/|\.\.?[\\/])?[^\s():]+):(\d+)(?::\d+)?/u.exec(text);
  if (!match?.[1] || !match[2]) return {};
  const file = match[1].replace(/^file:\/\//u, '');
  const line = Number(match[2]);
  return Number.isSafeInteger(line) && line > 0 ? { file, line } : { file };
}
