import type { Permission, ToolContext, ToolResult } from './types.js';
import { ToolRegistry } from './tool-registry.js';
import { toolFailure } from './tool-result.js';
import { hardenToolResult } from './tool-output.js';
import {
  DefaultProposedActionGuardrail,
  type ProposedActionDecision,
  type ProposedActionGuardrail,
} from './action-guardrail.js';

export interface ToolExecutorOptions {
  maxCalls?: number;
  timeoutMs?: number;
  maxOutputChars?: number;
  actionGuardrail?: ProposedActionGuardrail;
}

export interface ToolInvocationOutcome {
  result: ToolResult;
  decision: ProposedActionDecision;
}

/**
 * 所有内置工具和 MCP Adapter 的唯一执行入口。
 *
 * 这里是以后加入审批、审计、成本统计和沙箱的扩展点。模型永远不能直接
 * 调用 fs 或 child_process，只能提交一个经过校验的工具调用。
 */
export class ToolExecutor {
  private readonly maxCalls: number;
  private readonly timeoutMs: number;
  private readonly maxOutputChars: number;
  private readonly actionGuardrail: ProposedActionGuardrail;
  private callCount = 0;

  constructor(
    private readonly registry: ToolRegistry,
    options: ToolExecutorOptions = {},
  ) {
    this.maxCalls = options.maxCalls ?? 24;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.maxOutputChars = options.maxOutputChars ?? 12_000;
    this.actionGuardrail = options.actionGuardrail ?? new DefaultProposedActionGuardrail();
  }

  async invoke(
    name: string,
    args: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolResult> {
    return (await this.invokeWithDecision(name, args, context)).result;
  }

  async invokeWithDecision(
    name: string,
    args: Record<string, unknown>,
    context: ToolContext,
    onDecision?: (decision: ProposedActionDecision) => Promise<void>,
  ): Promise<ToolInvocationOutcome> {
    let tool;
    try {
      tool = this.registry.get(name);
    } catch {
      const decision = deniedDecision('unknown_tool', `未知工具：${name}`, args);
      await onDecision?.(decision);
      return wrap(decision, toolFailure('invalid', 'unknown_tool', `未知工具：${name}`, {
        data: { toolName: name },
      }), this.maxOutputChars);
    }
    if (this.callCount >= this.maxCalls) {
      const decision = deniedDecision('budget_exhausted', '已达到本回合工具调用预算', args);
      await onDecision?.(decision);
      return wrap(decision, toolFailure('failed', 'budget_exhausted', '已达到本回合工具调用预算', {
        data: { maxCalls: this.maxCalls },
      }), this.maxOutputChars);
    }

    const validation = this.registry.validate(name, args);
    if (!validation.valid) {
      const decision = deniedDecision('invalid_arguments', '工具参数不符合 Schema', args);
      await onDecision?.(decision);
      return wrap(decision, toolFailure('invalid', 'invalid_arguments', '工具参数不符合 Schema', {
        data: { issues: validation.issues },
      }), this.maxOutputChars);
    }

    let decision = await this.actionGuardrail.evaluate(tool, args, context);
    let reservedCall = false;
    if (decision.decision === 'allow' && this.callCount >= this.maxCalls) {
      decision = deniedDecision('budget_exhausted', '已达到本回合工具调用预算', args);
    } else if (decision.decision === 'allow') {
      this.callCount += 1;
      reservedCall = true;
    }
    try {
      await onDecision?.(decision);
    } catch (error) {
      if (reservedCall) this.callCount -= 1;
      throw error;
    }
    if (decision.decision === 'deny') {
      if (decision.reasonCode === 'budget_exhausted') {
        return wrap(decision, toolFailure('failed', 'budget_exhausted', decision.reason, {
          data: { maxCalls: this.maxCalls },
        }), this.maxOutputChars);
      }
      return wrap(decision, toolFailure('denied', 'permission_denied', decision.reason, {
        data: decisionData(decision),
      }), this.maxOutputChars);
    }
    if (decision.decision === 'require_approval') {
      return wrap(decision, toolFailure('denied', 'approval_required', decision.reason, {
        data: decisionData(decision),
      }), this.maxOutputChars);
    }
    if (context.signal.aborted) {
      if (reservedCall) this.callCount -= 1;
      return wrap(decision, toolFailure('cancelled', 'cancelled', '工具调用已取消'), this.maxOutputChars);
    }

    const controller = new AbortController();
    const controlState = { timedOut: false, cancelled: false };

    try {
      const result = await withExecutionControls(
        Promise.resolve().then(() => tool.execute(
          decision.normalizedArguments,
          { ...context, signal: controller.signal },
        )),
        this.timeoutMs,
        controller,
        context.signal,
        controlState,
      );
      return wrap(decision, result, this.maxOutputChars);
    } catch {
      if (controlState.timedOut) {
        return wrap(decision, toolFailure('timeout', 'timeout', '工具执行超时', {
          retryable: true,
          data: { timeoutMs: this.timeoutMs },
        }), this.maxOutputChars);
      }
      if (controlState.cancelled || context.signal.aborted) {
        return wrap(
          decision,
          toolFailure('cancelled', 'cancelled', '工具调用已取消'),
          this.maxOutputChars,
        );
      }
      return wrap(decision, toolFailure('failed', 'tool_failed', '工具执行失败'), this.maxOutputChars);
    }
  }

  resetBudget(): void {
    this.callCount = 0;
  }

  restoreBudget(callsUsed: number): void {
    if (!Number.isInteger(callsUsed) || callsUsed < 0) throw new Error('工具预算状态无效');
    this.callCount = callsUsed;
  }

  callsUsed(): number {
    return this.callCount;
  }

}

function wrap(
  decision: ProposedActionDecision,
  result: ToolResult,
  maxOutputChars: number,
): ToolInvocationOutcome {
  return { decision, result: hardenToolResult(result, maxOutputChars) };
}

function deniedDecision(
  reasonCode: string,
  reason: string,
  args: Record<string, unknown>,
): ProposedActionDecision {
  return { decision: 'deny', reasonCode, reason, normalizedArguments: structuredClone(args) };
}

function decisionData(decision: ProposedActionDecision): Record<string, string> {
  if (/^(?:invalid_path|path_|absolute_path|unc_path|device_path|drive_relative_path|alternate_data_stream|short_name|reserved_name|trailing_dot_or_space|git_metadata_denied|private_metadata_denied|reparse_point_denied|not_a_file|not_a_directory|file_too_large|workspace_changed|identity_unavailable|handle_identity_mismatch)/u.test(decision.reasonCode)) {
    return { pathPolicyCode: decision.reasonCode };
  }
  return { guardrailReasonCode: decision.reasonCode };
}

async function withExecutionControls<T>(
  promise: Promise<T>,
  timeoutMs: number,
  controller: AbortController,
  externalSignal: AbortSignal,
  state: { timedOut: boolean; cancelled: boolean },
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      state.timedOut = true;
      controller.abort();
      reject(new Error('TOOL_TIMEOUT'));
    }, timeoutMs);
  });
  const cancellation = new Promise<never>((_, reject) => {
    abort = () => {
      state.cancelled = true;
      controller.abort(externalSignal.reason);
      reject(new Error('TOOL_CANCELLED'));
    };
    if (externalSignal.aborted) abort();
    else externalSignal.addEventListener('abort', abort, { once: true });
  });
  try {
    return await Promise.race([promise, timeout, cancellation]);
  } finally {
    if (timer) clearTimeout(timer);
    if (abort) externalSignal.removeEventListener('abort', abort);
  }
}
