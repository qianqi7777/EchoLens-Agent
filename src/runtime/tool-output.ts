import { createHash } from 'node:crypto';
import type { ContextItem, ToolCallItem, ToolError } from '../core/messages.js';
import {
  redactTextWithReport,
  redactValueWithReport,
} from '../providers/redaction.js';
import type { ToolResult } from './types.js';

// 工具输出是不可信数据：在成为上下文之前统一做脱敏、截断、哈希与疑似注入标记，
// 避免未经约束的输出直接进入模型上下文或后续工具调用。
export function hardenToolResult(result: ToolResult, maxOutputChars: number): ToolResult {
  // 并集而非逐字段上报：同一份秘密可能散落在 summary / data / evidenceIds / error / content 任一处，
  // 只有汇总后的集合才能反映这份输出实际发生的脱敏，供审计与 toolOutputGuardrailDecision 判定。
  const redactions = new Set<string>();
  const summary = redactTextWithReport(result.summary);
  summary.redactions.forEach((kind) => redactions.add(kind));
  const data = redactValueWithReport(result.data);
  data.redactions.forEach((kind) => redactions.add(kind));
  // evidenceIds 多由路径或 URL 派生，可能携带 token、查询串或账号信息，必须与正文同等脱敏。
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

  // 失败调用不回填原始 content：错误路径下的原始输出常夹带部分写入结果、栈信息或内部路径，
  // 只序列化脱敏后的 error，既统一了失败证据的形状，也避免正文残留被当作可用证据引用。
  const contentReport = result.status === 'ok'
    ? redactTextWithReport(result.content)
    : redactTextWithReport(JSON.stringify({ error: safeError }));
  contentReport.redactions.forEach((kind) => redactions.add(kind));
  const content = truncate(contentReport.value, maxOutputChars);
  const guardrailFlags = detectUntrustedOutput(contentReport.value);
  // contentHash 基于脱敏前的原始 content 计算，同一份输出无论是否被截断都得到相同哈希，便于跨调用比对；
  // truncated / redactions / guardrailFlags 构成这份输出的可审计轨迹。
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
    // ToolResult 的不变量要求 status !== 'ok' 时必带 error，上面同一分支已构造 safeError。
    error: safeError!,
    outputMetadata,
  };
}

// 工具输出以 trust: 'untrusted' 回填为上下文：只能作为证据使用，不能成为 System Policy 或权限
// 判定的依据；contentHash 供溯源，truncation / redactions 记录被约束的部分。
export function createToolOutputContextItem(
  id: string,
  call: ToolCallItem,
  result: ToolResult,
): ContextItem {
  // 允许传入未经加固的结果（回放、checkpoint 恢复、测试直接构造都可能绕过 ToolExecutor），
  // 因此这里补做一次加固：trust: 'untrusted' 的标签必须有 outputMetadata 作为证据支撑。
  const hardened = result.outputMetadata ? result : hardenToolResult(result, 12_000);
  // hardenToolResult 的两个返回分支都会写入 outputMetadata，故此处可断言非空。
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

/**
 * 判定一份已加固工具输出的处置方式，供上下文回填前的最后一道检查使用。
 *
 * @returns `allow` 只表示输出已受长度与脱敏约束，不代表内容可信；调用方仍须保持
 * `trust: 'untrusted'` 标记，不得据此提升权限或改写 System Policy。`redact` 表示
 * 输出中检出敏感信息并已脱敏，脱敏后的正文可继续作为证据使用。
 */
// 决策顺序：存在脱敏时优先返回 redact；guardrailFlags 命中只记录标记、仍返回 allow——标记不作为阻断依据；
// 无任何命中才返回 allow，并用 reasonCode 区分三种来源。
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

// 截断预算包含后缀本身：整串长度不得超过 limit，所以正文要先扣掉后缀长度，否则回填的
// 上下文会静默超出 maxOutputChars。
// 两遍迭代求不动点：后缀里的丢弃字符数会随 available 变化而改变自身位数（99→100→1000），
// 位数变化又反过来改变 available；两位以内的抖动两遍即可收敛，且末次 slice 上界被 clamp 到 0，
// 因此 limit 小于后缀时只会返回 suffix 而非负数长度。
function truncate(value: string, limit: number): string {
  if (value.length <= limit) return value;
  let suffix = '\n[output truncated]';
  for (let pass = 0; pass < 2; pass += 1) {
    const available = Math.max(0, limit - suffix.length);
    suffix = `\n[output truncated: ${value.length - available} chars]`;
  }
  return `${value.slice(0, Math.max(0, limit - suffix.length))}${suffix}`;
}

// 从不可信输出中识别疑似指令注入的标记（忽略先前指令、引用 system|developer 提示、角色 token、
// 请求执行命令）。这些标记仅写入 guardrailFlags 供审查，本身不阻断工具调用。
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
