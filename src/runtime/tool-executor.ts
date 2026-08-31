import type { Permission, ToolContext, ToolResult } from './types.js';
import { ToolRegistry } from './tool-registry.js';
import { toolFailure } from './tool-result.js';
import { hardenToolResult } from './tool-output.js';
import {
  createApprovalRequest,
  type ApprovalDecision,
  type ApprovalRequest,
  type ApprovalStore,
} from './approval.js';
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
  approvalStore?: ApprovalStore;
  onApprovalRequest?: (request: ApprovalRequest) => Promise<void>;
  approvalDecider?: (request: ApprovalRequest) => Promise<ApprovalDecision | undefined>;
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
  private readonly approvalStore?: ApprovalStore;
  private readonly onApprovalRequest?: ToolExecutorOptions['onApprovalRequest'];
  private readonly approvalDecider?: ToolExecutorOptions['approvalDecider'];
  private callCount = 0;

  constructor(
    private readonly registry: ToolRegistry,
    options: ToolExecutorOptions = {},
  ) {
    // 回合级预算默认值：单回合工具调用数、单次执行时限与单次输出上限在此封顶，
    // 即便调用方未提供 options，这些默认值也保证执行边界存在。
    this.maxCalls = options.maxCalls ?? 24;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.maxOutputChars = options.maxOutputChars ?? 12_000;
    this.actionGuardrail = options.actionGuardrail ?? new DefaultProposedActionGuardrail();
    this.approvalStore = options.approvalStore;
    this.onApprovalRequest = options.onApprovalRequest;
    this.approvalDecider = options.approvalDecider;
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
    onApprovalRequest?: (request: ApprovalRequest) => Promise<void>,
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
    // deny-first：未知工具、预算、Schema 校验、Guardrail、审批依次为执行前的安全网关，
    // 任一拒绝即返回，确保在可能产生副作用的 tool.execute 之前完成全部检查。
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
    if (decision.decision === 'require_approval') {
      // 审批请求先交给两个 onApprovalRequest 钩子向 UI 暴露，再查记忆与 decider；
      // 命中记忆（approvalStore）时不再询问 decider，避免对完全相同参数重复打扰用户。
      const request = createApprovalRequest({
        id: context.approvalContext?.callId ?? `${tool.name}:${Date.now()}`,
        sessionId: context.approvalContext?.sessionId,
        runId: context.approvalContext?.runId,
        callId: context.approvalContext?.callId,
        toolName: tool.name,
        permission: tool.permission,
        arguments: decision.normalizedArguments,
        workspaceRoot: context.workspaceRoot,
        workspaceRevision: context.approvalContext?.workspaceRevision,
        reasonCode: decision.reasonCode,
        reason: decision.reason,
        createdAt: new Date().toISOString(),
      });
      await this.onApprovalRequest?.(request);
      await onApprovalRequest?.(request);
      const remembered = await this.approvalStore?.find(request);
      const selected = remembered ?? await this.approvalDecider?.(request);
      if (selected) {
        if (!remembered) await this.approvalStore?.save(request, selected);
        decision = selected.decision === 'allow'
          ? { ...decision, decision: 'allow', reasonCode: selected.ruleId ?? 'approval_granted', reason: selected.reason ?? '用户已批准动作' }
          : { ...decision, decision: 'deny', reasonCode: selected.ruleId ?? 'approval_denied', reason: selected.reason ?? '用户拒绝动作' };
      }
    }
    // 审批等待期间其它并行工具可能已占用预算，allow 后再次校验 maxCalls，
    // 避免同一回合内工具调用数静默超预算。
    let reservedCall = false;
    if (decision.decision === 'allow' && this.callCount >= this.maxCalls) {
      decision = deniedDecision('budget_exhausted', '已达到本回合工具调用预算', args);
    } else if (decision.decision === 'allow') {
      this.callCount += 1;
      reservedCall = true;
    }
    try {
      // 先登记决策再执行：onDecision 抛错时撤回刚预留的 callCount，避免回调失败吃掉预算。
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
    // 审批与决策完成后、真正执行前再次检查 abort，避免取消后仍启动工具。
    if (context.signal.aborted) {
      if (reservedCall) this.callCount -= 1;
      return wrap(decision, toolFailure('cancelled', 'cancelled', '工具调用已取消'), this.maxOutputChars);
    }

    // 工具收到的是本地 signal 而非外部 signal：超时与外部取消共用同一 controller，
    // 两者都会中止工具，由 controlState 记录最终是 timedOut 还是 cancelled。
    const controller = new AbortController();
    const controlState = { timedOut: false, cancelled: false };

    try {
      // 执行使用审批快照 normalizedArguments 而非原始调用参数：Guardrail 可能已改写或
      // 清除部分参数，原始参数不得绕过 Guardrail 审批内容执行。
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
      // 超时标记 retryable（可能发生在副作用写入前）；取消/普通失败不标记，
      // 避免对已产生副作用的工具重复执行。
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

  /**
   * 从持久化预算恢复本轮已用调用数。
   * @throws callsUsed 非整数或小于 0 时抛出错误。
   */
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
  // 工具输出作为不可信证据回填，必须经 hardenToolResult 截断与脱敏；
  // 裸输出不得直接进入 System Policy 或权限集合。
  return { decision, result: hardenToolResult(result, maxOutputChars) };
}

function deniedDecision(
  reasonCode: string,
  reason: string,
  args: Record<string, unknown>,
): ProposedActionDecision {
  return { decision: 'deny', reasonCode, reason, normalizedArguments: structuredClone(args) };
}

// 命中路径策略错误码前缀时以 pathPolicyCode 单独呈现，便于 UI 区分路径类拒绝；
// 前缀清单需与 path-policy 的错误码保持同步，未列出的 reasonCode 一律归为 guardrailReasonCode。
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
  // 超时与取消各自用 reject 的 promise 参与 race，谁先到谁决定结果；
  // 两者都会调 controller.abort() 终止工具，但用 state 标志区分最终归类。
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
