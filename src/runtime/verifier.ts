import type { AgentTraceItem } from './types.js';

export interface Claim {
  name: string;
  nodeId: string;
  reason: string;
  confidence: number;
  evidenceIds: string[];
}

export interface VerificationResult {
  accepted: Claim[];
  unresolved: string[];
  trace: AgentTraceItem[];
}

/** 验证模型声明是否拥有节点和证据，不把未经验证的文本当作事实。 */
export function verifyClaims(claims: Claim[], knownNodeIds: ReadonlySet<string>, knownEvidenceIds: ReadonlySet<string>): VerificationResult {
  const accepted: Claim[] = [];
  const unresolved: string[] = [];
  let rejected = 0;
  for (const claim of claims) {
    const hasNode = Boolean(claim.nodeId && knownNodeIds.has(claim.nodeId));
    const hasEvidence = claim.evidenceIds.some((id) => knownEvidenceIds.has(id));
    if (hasNode && hasEvidence) accepted.push({ ...claim, confidence: clamp01(claim.confidence) });
    else {
      rejected += 1;
      unresolved.push(`${claim.name}（待核查：缺少节点或证据）`);
    }
  }
  return { accepted, unresolved: [...new Set(unresolved)], trace: [{ type: 'warning', message: `Verifier：检查 ${claims.length} 条，保留 ${accepted.length} 条，拒绝 ${rejected} 条` }] };
}

export function clamp01(value: unknown): number {
  const number = typeof value === 'number' && Number.isFinite(value) ? value : 0;
  return Math.max(0, Math.min(1, number));
}

