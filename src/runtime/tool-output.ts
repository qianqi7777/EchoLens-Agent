import { createHash } from 'node:crypto';
import type { ContextItem, ToolCallItem, ToolError } from '../core/messages.js';
import {
  redactTextWithReport,
  redactValueWithReport,
} from '../providers/redaction.js';
import type { ToolResult } from './types.js';

export function hardenToolResult(result: ToolResult, maxOutputChars: number): ToolResult {
  const redactions = new Set<string>();
  const summary = redactTextWithReport(result.summary);
  summary.redactions.forEach((kind) => redactions.add(kind));
  const data = redactValueWithReport(result.data);
  data.redactions.forEach((kind) => redactions.add(kind));
  const evidenceIds = result.evidenceIds.map((evidenceId) => {
    const report = redactTextWithReport(evidenceId);
    report.redactions.forEach((kind) => redactions.add(kind));
    return report.value;
  });

  let safeError: ToolError | undefined;
  if (result.error) {
    const message = redactTextWithReport(result.error.message);
    message.redactions.forEach((kind) => redactions.add(kind));
    const errorData = redactValueWithReport(result.error.data);
    errorData.redactions.forEach((kind) => redactions.add(kind));
    safeError = {
      ...result.error,
      message: message.value,
      data: errorData.value,
    };
  }

  const contentReport = result.status === 'ok'
    ? redactTextWithReport(result.content)
    : redactTextWithReport(JSON.stringify({ error: safeError }));
  contentReport.redactions.forEach((kind) => redactions.add(kind));
  const content = truncate(contentReport.value, maxOutputChars);
  const guardrailFlags = detectUntrustedOutput(contentReport.value);
  const outputMetadata = {
    hashAlgorithm: 'sha256' as const,
    contentHash: createHash('sha256').update(result.content, 'utf8').digest('hex'),
    originalChars: result.content.length,
    returnedChars: content.length,
    truncated: content.length < contentReport.value.length,
    redactions: [...redactions].sort(),
    guardrailFlags,
  };

  if (result.status === 'ok') {
    return {
      ...result,
      content,
      summary: summary.value,
      data: data.value,
      evidenceIds,
      outputMetadata,
    };
  }
  return {
    ...result,
    content,
    summary: summary.value,
    data: data.value,
    evidenceIds,
    error: safeError!,
    outputMetadata,
  };
}

export function createToolOutputContextItem(
  id: string,
  call: ToolCallItem,
  result: ToolResult,
): ContextItem {
  const hardened = result.outputMetadata ? result : hardenToolResult(result, 12_000);
  const metadata = hardened.outputMetadata!;
  return {
    id,
    kind: 'tool_output',
    content: hardened.content,
    source: { type: 'tool', toolCallId: call.callId, toolName: call.name },
    trust: 'untrusted',
    contentHash: metadata.contentHash,
    truncation: metadata.truncated
      ? { originalChars: metadata.originalChars, returnedChars: metadata.returnedChars }
      : undefined,
    redactions: metadata.redactions,
  };
}

export function toolOutputGuardrailDecision(result: ToolResult): {
  decision: 'allow' | 'redact';
  reasonCode: string;
} {
  const metadata = result.outputMetadata;
  if (metadata?.redactions.length) {
    return { decision: 'redact', reasonCode: 'sensitive_output_redacted' };
  }
  if (metadata?.guardrailFlags?.length) {
    return { decision: 'allow', reasonCode: 'untrusted_instruction_pattern_detected' };
  }
  return { decision: 'allow', reasonCode: 'untrusted_output_bounded' };
}

function truncate(value: string, limit: number): string {
  if (value.length <= limit) return value;
  let suffix = '\n[output truncated]';
  for (let pass = 0; pass < 2; pass += 1) {
    const available = Math.max(0, limit - suffix.length);
    suffix = `\n[output truncated: ${value.length - available} chars]`;
  }
  return `${value.slice(0, Math.max(0, limit - suffix.length))}${suffix}`;
}

function detectUntrustedOutput(value: string): string[] {
  const flags = new Set<string>();
  if (/ignore\s+(all\s+)?previous\s+instructions?/iu.test(value)) flags.add('prompt_instruction');
  if (/(system|developer)\s+(prompt|message)/iu.test(value)) flags.add('privileged_prompt_reference');
  if (/<\|(?:system|developer)\|>/iu.test(value)) flags.add('role_token');
  if (/execute\s+(?:this\s+)?(?:shell|command)|运行.{0,8}(?:命令|脚本)/iu.test(value)) {
    flags.add('action_request');
  }
  return [...flags].sort();
}
