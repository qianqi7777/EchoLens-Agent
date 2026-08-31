import type {
  ConversationItem,
  ToolExecutionStatus,
  ToolResultItem,
} from '../core/messages.js';
import type { Permission } from '../core/permissions.js';
import type { ProviderStopReason, TokenUsage } from '../providers/types.js';
import type { ApprovalDecision, ApprovalRequest } from '../runtime/approval.js';

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
  state: RunState;
  items: ConversationItem[];
}

export type AgentEventPayload =
  | { type: 'session.created'; workspaceRoot: string }
  | { type: 'turn.started'; userMessage: string }
  | { type: 'turn.steered'; message: string }
  | { type: 'run.started'; model: string; resumed: boolean }
  | { type: 'model.started'; step: number }
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
    }
  | { type: 'model.failed'; step: number; code: string; retryable: boolean }
  | { type: 'tool.started'; callId: string; toolName: string; callIndex: number }
  | { type: 'tool.progress'; callId: string; toolName: string; progress: number; total?: number }
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
  | { type: 'verification.completed'; verified: boolean; issueCount: number }
  | { type: 'usage.recorded'; model: string; usage: TokenUsage; cachedReadTokens?: number }
  | { type: 'run.completed'; answer: string; degraded: boolean }
  | { type: 'run.paused'; reason: 'step_budget' | 'tool_budget' | 'approval_required' }
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
