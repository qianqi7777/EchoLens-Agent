import { randomUUID } from 'node:crypto';

export interface GoalEvidence {
  id: string;
  kind: 'checkpoint' | 'verification' | 'note';
  ref: string;
  summary: string;
  at: string;
}

export interface AgentGoal {
  id: string;
  statement: string;
  criteria: string[];
  status: 'active' | 'met' | 'dropped';
  evidence: GoalEvidence[];
}

export function createGoal(statement: string, criteria: readonly string[] = []): AgentGoal {
  const normalized = statement.trim();
  if (!normalized) throw new Error('目标描述不能为空');
  return {
    id: randomUUID(),
    statement: normalized,
    criteria: criteria.map((item) => item.trim()).filter(Boolean),
    status: 'active',
    evidence: [],
  };
}

export function createGoalEvidence(
  kind: GoalEvidence['kind'],
  ref: string,
  summary: string,
): GoalEvidence {
  return { id: randomUUID(), kind, ref, summary, at: new Date().toISOString() };
}
