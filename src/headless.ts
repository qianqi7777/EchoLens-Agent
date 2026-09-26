import type { AgentRunResult } from './runtime/resumable-react-agent.js';

export const HEADLESS_OUTPUT_VERSION = 1 as const;
export interface HeadlessOutput {
  version: typeof HEADLESS_OUTPUT_VERSION;
  ok: boolean;
  state?: AgentRunResult['state'];
  answer?: string;
  turnId?: string;
  sessionId?: string;
  verified?: boolean;
  degraded?: boolean;
  error?: { code: string; message: string };
}

export function headlessSuccess(result: AgentRunResult): HeadlessOutput {
  const toolError = [...result.items].reverse().find((item) => item.type === 'tool_result' && item.error);
  const error = toolError?.type === 'tool_result' && toolError.error
    ? { code: toolError.error.code, message: toolError.error.message }
    : undefined;
  return {
    version: HEADLESS_OUTPUT_VERSION, ok: result.state === 'completed', state: result.state,
    answer: result.answer, turnId: result.turnId, sessionId: result.sessionId,
    verified: result.finalSummary.verified, degraded: result.degraded, error,
  };
}

export function headlessFailure(error: unknown): HeadlessOutput {
  const message = error instanceof Error ? error.message : String(error);
  const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
    ? error.code : 'headless_error';
  return { version: HEADLESS_OUTPUT_VERSION, ok: false, error: { code, message } };
}

export function headlessExitCode(output: HeadlessOutput): number {
  if (output.ok && output.verified !== false) return 0;
  if (output.error?.code === 'permission_denied' || output.error?.code === 'approval_required') return 3;
  if (output.state === 'completed' && output.verified === false) return 2;
  return 1;
}

export function headlessPrompt(argv: readonly string[]): string {
  const longIndex = argv.indexOf('--prompt');
  const shortIndex = argv.indexOf('-p');
  const index = longIndex >= 0 ? longIndex : shortIndex;
  const prompt = index >= 0 ? argv[index + 1] : undefined;
  if (!prompt?.trim()) throw new Error('无头模式需要 --prompt <内容>');
  return prompt.trim();
}
