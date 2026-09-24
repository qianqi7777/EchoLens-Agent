import type {
  ConversationItem,
  ToolExecutionStatus,
  ToolResultItem,
} from '../core/messages.js';
import type { Permission } from '../core/permissions.js';
import type { ProviderStopReason, TokenUsage, ModelRoutingSnapshot, ToolChoice } from '../providers/types.js';
import type { ApprovalDecision, ApprovalRequest } from '../runtime/approval.js';
import type { AgentPlan } from '../runtime/structured-output.js';
import type { AgentGoal, GoalEvidence } from '../runtime/goal.js';

// 事件 schema 版本，仅在不兼容变更时递增；读取端以该值校验事件结构。
export const AGENT_EVENT_VERSION = 1 as const;

export type RunState = 'running' | 'completed' | 'paused' | 'cancelled' | 'failed';

export interface AgentCheckpoint {
  version: 1;
  sessionId: string;
  turnId: string;
  runId: string;
  step: number;
  // 恢复合并 tool.completed 仅在 tools 阶段执行；model 阶段说明该批次已进入模型步骤。
  phase: 'model' | 'tools' | 'finished';
  toolCallsUsed: number;
  internalVerificationCallIds?: string[];
  state: RunState;
  items: ConversationItem[];
  hookContexts?: RuntimeHookContext[];
  routing?: ModelRoutingSnapshot;
}

export interface RuntimeHookContext {
  hookId: string;
  scope: 'user' | 'project';
  content: string;
  contentHash: string;
}

export type AgentEventPayload =
  | { type: 'session.created'; workspaceRoot: string }
  | { type: 'turn.started'; userMessage: string }
  | { type: 'turn.steered'; message: string }
  | { type: 'run.started'; model: string; resumed: boolean }
  | {
      type: 'navigation.resolved';
      mode: 'off' | 'none' | 'direct' | 'advisory' | 'search';
      confidence: number;
      candidateCount: number;
      matched: boolean;
    }
  | { type: 'route.configured'; routing: ModelRoutingSnapshot }
  | {
      type: 'route.selected';
      model: string;
      mode: string;
      tier: number;
      reason: string;
      candidates: string[];
      actualModel?: string;
      phase?: string;
      phaseOverride?: 'plan' | 'execute' | 'verify';
      suggestedModel?: string;
    }
  | { type: 'route.fallback'; fromModel: string; toModel: string; reason: string }
  | { type: 'route.fallback_rejected'; model: string; reason: string }
  | { type: 'model.started'; step: number; toolChoice?: ToolChoice; navigationMode?: string }
  | { type: 'model.output.delta'; step: number; delta: string }
  | { type: 'model.retry'; step: number; attempt: number; delayMs: number; code: string }
  | {
      type: 'model.completed';
      step: number;
      stopReason: ProviderStopReason;
      requestId?: string;
      usage?: TokenUsage;
      elapsedMs?: number;
      retries?: number;
      toolCallCount?: number;
    }
  | { type: 'model.failed'; step: number; code: string; retryable: boolean }
  | { type: 'tool.started'; callId: string; toolName: string; callIndex: number }
  | { type: 'tool.progress'; callId: string; toolName: string; progress: number; total?: number }
  | {
      type: 'hook.completed';
      hookId: string;
      scope: 'user' | 'project';
      hookEventName: 'SessionStart' | 'UserPromptSubmit' | 'PreToolUse' | 'PostToolUse' | 'Stop' | 'SessionEnd';
      status: 'completed' | 'denied' | 'timeout' | 'failed' | 'cancelled' | 'skipped';
      durationMs: number;
      reasonCode: string;
    }
  | {
      type: 'tool.completed';
      callId: string;
      toolName: string;
      callIndex: number;
      status: ToolExecutionStatus;
      elapsedMs: number;
      evidenceIds: string[];
      result?: ToolResultItem;
    }
  | {
      type: 'guardrail.decision';
      target: 'tool_output' | 'proposed_action';
      decision: 'allow' | 'deny' | 'redact' | 'require_approval';
      reasonCode: string;
      callId?: string;
    }
  | {
      type: 'approval.requested';
      approvalId: string;
      callId: string;
      permission: Permission;
      reasonCode: string;
      request?: ApprovalRequest;
    }
  | { type: 'approval.decided'; approvalId: string; decision: ApprovalDecision['decision']; scope: ApprovalDecision['scope'] }
  | {
      type: 'workspace.file.observed';
      operation: 'read' | 'search' | 'list';
      path: string;
      evidenceIds: string[];
      callId: string;
    }
  | { type: 'checkpoint.saved'; checkpoint: AgentCheckpoint }
  | {
      type: 'change.set.completed';
      files: string[];
      checkpointIds: string[];
      verification?: { status: 'passed' | 'failed' | 'skipped'; issueCount: number };
    }
  | { type: 'verification.started'; changedFiles: string[]; commands: string[] }
  | { type: 'verification.skipped'; reason: string; changedFiles: string[] }
  | { type: 'verification.completed'; verified: boolean; issueCount: number; results?: import('../runtime/verification.js').EditVerificationResult[] }
  | { type: 'plan.proposed'; planId: string; plan?: AgentPlan; raw?: string }
  | { type: 'plan.decided'; planId: string; decision: 'approved' | 'edited' | 'rejected'; plan?: AgentPlan }
  | { type: 'goal.set'; goal: AgentGoal }
  | { type: 'goal.progress'; goalId: string; evidence: GoalEvidence }
  | { type: 'goal.closed'; goalId: string; status: 'met' | 'dropped' }
  | { type: 'usage.recorded'; model: string; usage: TokenUsage; cachedReadTokens?: number }
  | { type: 'run.completed'; answer: string; degraded: boolean }
  | { type: 'run.paused'; reason: 'step_budget' | 'tool_budget' | 'approval_required' | 'verification_failed' }
  | { type: 'run.cancelled'; reason: string }
  | { type: 'run.failed'; code: string; retryable: boolean };

export interface AgentEvent {
  version: typeof AGENT_EVENT_VERSION;
  eventId: string;
  sessionId: string;
  turnId?: string;
  runId?: string;
  // seq 由 Event Store 单写者按 1 起始连续分配，恢复时要求严格递增（不能有缺口或乱序）。
  seq: number;
  timestamp: string;
  parentEventId?: string;
  payload: AgentEventPayload;
}

// 写入方提供的字段；eventId、seq、timestamp 由 Event Store 统一分配，不出现在 intent 中。
export interface AgentEventIntent {
  turnId?: string;
  runId?: string;
  parentEventId?: string;
  payload: AgentEventPayload;
}

export interface AgentEventSink {
  append(intent: AgentEventIntent): Promise<AgentEvent>;
}
