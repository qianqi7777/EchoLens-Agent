import { messageText, type ConversationItem } from '../core/messages.js';
import type { Permission } from '../core/permissions.js';
import { ProviderError } from '../providers/provider-error.js';
import type {
  ModelProvider,
  ModelProviderRunLifecycle,
  ModelRouteEvent,
  ModelRoutingSnapshot,
  ProviderCapabilities,
  ProviderRequest,
  ProviderResult,
  ProviderStreamEvent,
} from '../providers/types.js';
import type { PrivacyLevel } from './model-router.js';

export type TaskTier = 0 | 1 | 2 | 3;
export type ExecutionPhase = 'plan' | 'execute' | 'verify';
export type ModelRoutingMode = 'off' | 'auto' | 'fast' | 'balanced' | 'quality' | 'privacy' | `pinned:${string}`;

export interface ModelProfile {
  id: string;
  provider: ModelProvider;
  tier: TaskTier;
  privacy: PrivacyLevel;
  estimatedInputCostPer1k?: number;
  estimatedOutputCostPer1k?: number;
  latencyHintMs?: number;
}

export interface TaskClassification {
  tier: TaskTier;
  phase: ExecutionPhase;
  requiresTools: boolean;
  reason: string;
}

export interface RoutedModelProviderOptions {
  mode?: ModelRoutingMode;
  defaultProfileId?: string;
  allowTierDowngrade?: boolean;
  maxFallbacks?: number;
  now?: () => number;
  circuitFailureThreshold?: number;
  circuitCooldownMs?: number;
}

interface Candidate {
  profile: ModelProfile;
  score: number;
}

interface HealthState {
  consecutiveFailures: number;
  blockedUntil?: number;
}

/**
 * 在一次 Agent run 中锁定模型的路由 Provider。
 *
 * 模型选择只在 beginRun/beginResume 发生。请求级 fallback 仅在 Provider 尚未输出
 * 任意文本时发生，因此不会拼接不同模型的输出，也不会重放已经进入工具阶段的 Agent run。
 */
export class RoutedModelProvider implements ModelProvider, ModelProviderRunLifecycle {
  private readonly profiles: ModelProfile[];
  private mode: ModelRoutingMode;
  private readonly defaultProfile: ModelProfile;
  private readonly allowTierDowngrade: boolean;
  private readonly maxFallbacks: number;
  private readonly now: () => number;
  private readonly circuitFailureThreshold: number;
  private readonly circuitCooldownMs: number;
  private readonly health = new Map<string, HealthState>();
  private active: ModelProfile;
  private fallbackCandidates: ModelProfile[] = [];
  private fallbackCount = 0;
  private phase: ExecutionPhase = 'execute';
  private automaticPhase: ExecutionPhase = 'execute';
  private phaseOverride: ExecutionPhase | undefined;
  private requiresTools = false;
  private toolsStarted = false;
  private runCostUsd = 0;
  private sessionCostUsd = 0;
  private costUnknown = false;
  private readonly routeEvents: ModelRouteEvent[] = [];

  constructor(profiles: readonly ModelProfile[], options: RoutedModelProviderOptions = {}) {
    if (profiles.length === 0) throw new Error('模型路由至少需要一个模型 Profile');
    assertProfiles(profiles);
    this.profiles = [...profiles];
    this.defaultProfile = profileById(this.profiles, options.defaultProfileId) ?? this.profiles[0]!;
    this.active = this.defaultProfile;
    this.mode = options.mode ?? 'off';
    this.allowTierDowngrade = options.allowTierDowngrade ?? true;
    this.maxFallbacks = Math.max(0, options.maxFallbacks ?? 1);
    this.now = options.now ?? Date.now;
    this.circuitFailureThreshold = Math.max(1, options.circuitFailureThreshold ?? 2);
    this.circuitCooldownMs = Math.max(1_000, options.circuitCooldownMs ?? 30_000);
    const pinned = pinnedProfileId(this.mode);
    if (pinned && !profileById(this.profiles, pinned)) {
      throw new Error(`固定模型 Profile 不存在：${pinned}`);
    }
  }

  get model(): string {
    return this.active.provider.model;
  }

  get capabilities(): ProviderCapabilities {
    return this.active.provider.capabilities;
  }

  get privacy(): PrivacyLevel { return this.active.privacy; }

  currentPhase(): ExecutionPhase { return this.phase; }

  allowedPermissions(): ReadonlySet<Permission> | undefined {
    if (this.phase === 'plan') return new Set<Permission>(['workspace.read']);
    if (this.phase === 'verify') return new Set<Permission>(['workspace.read', 'process.exec']);
    return undefined;
  }

  beginRun(userMessage: string): void {
    const classification = classifyTask(userMessage);
    this.automaticPhase = classification.phase;
    this.phase = this.phaseOverride ?? classification.phase;
    this.requiresTools = classification.requiresTools;
    this.toolsStarted = false;
    this.runCostUsd = 0;
    this.costUnknown = false;
    this.select(classification);
  }

  beginResume(snapshot?: ModelRoutingSnapshot): void {
    if (snapshot) this.restore(snapshot);
    // 有快照时以 checkpoint 的 locked 标志为准；旧 Session 没有路由快照时保守锁定，
    // 防止无法证明工具是否已执行的恢复路径重放到另一模型。
    if (!snapshot) this.toolsStarted = true;
  }

  restore(snapshot: ModelRoutingSnapshot): void {
    const profile = profileById(this.profiles, snapshot.profileId);
    if (!profile) throw new Error(`Checkpoint 引用的模型 Profile 不在当前候选池：${snapshot.profileId}`);
    this.active = profile;
    this.mode = routingMode(snapshot.mode);
    this.phase = snapshot.phase;
    this.automaticPhase = snapshot.automaticPhase ?? snapshot.phase;
    this.phaseOverride = snapshot.phaseOverride;
    this.fallbackCount = snapshot.fallbacks;
    this.runCostUsd = snapshot.runCostUsd;
    this.sessionCostUsd = snapshot.sessionCostUsd;
    this.costUnknown = snapshot.costUnknown;
    this.toolsStarted = snapshot.locked;
    // 旧 checkpoint 不记录任务工具需求，恢复时按需要工具处理，避免将有工具调用的
    // 恢复链路切到不支持工具的模型。
    this.requiresTools = snapshot.requiresTools ?? true;
    this.fallbackCandidates = this.rankFallbackCandidates({
      tier: profile.tier,
      phase: this.phase,
      requiresTools: this.requiresTools,
      reason: '恢复中的任务',
    }, profile);
  }

  snapshot(): ModelRoutingSnapshot {
    return {
      version: 1,
      mode: this.mode,
      phase: this.phase,
      automaticPhase: this.automaticPhase,
      phaseOverride: this.phaseOverride,
      profileId: this.active.id,
      tier: this.active.tier,
      requiresTools: this.requiresTools,
      locked: this.toolsStarted,
      fallbacks: this.fallbackCount,
      runCostUsd: this.runCostUsd,
      sessionCostUsd: this.sessionCostUsd,
      costUnknown: this.costUnknown,
    };
  }

  fork(): RoutedModelProvider {
    const copy = new RoutedModelProvider(this.profiles, {
      mode: this.mode,
      defaultProfileId: this.defaultProfile.id,
      allowTierDowngrade: this.allowTierDowngrade,
      maxFallbacks: this.maxFallbacks,
      now: this.now,
      circuitFailureThreshold: this.circuitFailureThreshold,
      circuitCooldownMs: this.circuitCooldownMs,
    });
    copy.restore(this.snapshot());
    return copy;
  }

  markToolsStarted(): void { this.toolsStarted = true; }

  configure(mode?: string, phase?: string): string[] {
    let nextMode = this.mode;
    let nextPhaseOverride = this.phaseOverride;
    if (mode) {
      const normalized = routingMode(mode);
      const pinned = pinnedProfileId(normalized);
      if (pinned && !profileById(this.profiles, pinned)) {
        throw new Error(`固定模型 Profile 不存在：${pinned}`);
      }
      nextMode = normalized;
    }
    if (phase) {
      if (phase === 'auto') nextPhaseOverride = undefined;
      else if (phase === 'plan' || phase === 'execute' || phase === 'verify') nextPhaseOverride = phase;
      else throw new Error('阶段必须为 auto、plan、execute 或 verify');
    }
    this.mode = nextMode;
    this.phaseOverride = nextPhaseOverride;
    this.phase = nextPhaseOverride ?? this.automaticPhase;
    return this.status();
  }

  status(): string[] {
    return [
      `mode=${this.mode}`,
      `model=${this.active.id} (${this.active.provider.model})`,
      `phase=${this.phaseOverride ?? 'auto'}`,
      `tier=${this.active.tier}`,
      `privacy=${this.active.privacy}`,
    ];
  }

  takeRouteEvents(): ModelRouteEvent[] {
    return this.routeEvents.splice(0, this.routeEvents.length);
  }

  async complete(request: ProviderRequest): Promise<ProviderResult> {
    while (true) {
      try {
        const result = await this.active.provider.complete(request);
        this.recordSuccess(this.active);
        this.recordUsage(this.active, result);
        return result;
      } catch (error) {
        if (!this.tryFallback(error)) throw error;
      }
    }
  }

  async *stream(request: ProviderRequest): AsyncGenerator<ProviderStreamEvent> {
    let provider = this.active;
    let emittedText = false;
    while (true) {
      try {
        if (!provider.provider.capabilities.supportsStreaming || !provider.provider.stream) {
          const result = await provider.provider.complete(request);
          this.recordSuccess(provider);
          this.recordUsage(provider, result);
          yield { type: 'response.completed', result };
          return;
        }
        for await (const event of provider.provider.stream(request)) {
          if (event.type === 'output_text.delta' && event.delta.length > 0) emittedText = true;
          yield event;
          if (event.type === 'response.completed') this.recordUsage(provider, event.result);
        }
        this.recordSuccess(provider);
        return;
      } catch (error) {
        if (emittedText) {
          if (error instanceof ProviderError && fallbackAllowed(error)) this.recordFailure(provider);
          this.routeEvents.push({
            type: 'fallback_rejected',
            model: provider.id,
            reason: '模型已输出文本，不能混合不同模型的流式结果',
          });
          throw error;
        }
        const fallback = this.tryFallback(error);
        if (!fallback) throw error;
        provider = fallback;
      }
    }
  }

  private select(classification: TaskClassification): void {
    this.fallbackCount = 0;
    const candidates = this.rankCandidates(classification);
    if (candidates.length === 0) {
      throw new Error(`没有满足 ${classification.reason} 的模型候选`);
    }
    this.active = candidates[0]!.profile;
    this.fallbackCandidates = this.rankFallbackCandidates(classification, this.active);
    this.routeEvents.push({
      type: 'selected',
      model: this.active.id,
      mode: this.mode,
      tier: this.active.tier,
      reason: classification.reason,
      candidates: candidates.map((candidate) => candidate.profile.id),
      actualModel: this.active.provider.model,
      phase: this.phase,
      phaseOverride: this.phaseOverride,
      suggestedModel: this.mode === 'off' ? undefined : candidates[0]?.profile.id,
    });
  }

  private rankCandidates(classification: TaskClassification): Candidate[] {
    const pinned = pinnedProfileId(this.mode);
    if (pinned) {
      const profile = profileById(this.profiles, pinned);
      if (!profile) throw new Error(`固定模型不存在：${pinned}`);
      if (!isUsable(profile, classification, this.defaultProfile.privacy, this.health, this.now())) {
        throw new Error(`固定模型不满足当前任务能力或处于熔断状态：${pinned}`);
      }
      return [{ profile, score: 0 }];
    }
    if (this.mode === 'off') return [{ profile: this.defaultProfile, score: 0 }];
    const usable = this.profiles.filter((profile) => isUsable(
      profile,
      classification,
      this.defaultProfile.privacy,
      this.health,
      this.now(),
    ));
    return usable.map((profile) => ({ profile, score: candidateScore(profile, classification, this.mode) }))
      .sort((left, right) => right.score - left.score || left.profile.id.localeCompare(right.profile.id));
  }

  private rankFallbackCandidates(
    classification: TaskClassification,
    active: ModelProfile,
  ): ModelProfile[] {
    return this.profiles
      .filter((profile) => profile.id !== active.id && isFallbackUsable(
        profile,
        classification,
        active.privacy,
        this.health,
        this.now(),
      ))
      .map((profile) => ({ profile, score: candidateScore(profile, classification, this.mode) }))
      .sort((left, right) => right.score - left.score || left.profile.id.localeCompare(right.profile.id))
      .map((candidate) => candidate.profile);
  }

  private tryFallback(error: unknown): ModelProfile | undefined {
    const providerError = error instanceof ProviderError ? error : undefined;
    if (!providerError || !fallbackAllowed(providerError)) {
      this.routeEvents.push({
        type: 'fallback_rejected',
        model: this.active.id,
        reason: fallbackRejectionReason(providerError),
      });
      return undefined;
    }
    this.recordFailure(this.active);
    if (this.mode === 'off' || pinnedProfileId(this.mode)) {
      this.routeEvents.push({ type: 'fallback_rejected', model: this.active.id, reason: '当前 Session 已固定模型' });
      return undefined;
    }
    if (this.toolsStarted) {
      this.routeEvents.push({ type: 'fallback_rejected', model: this.active.id, reason: '工具阶段已经开始，不能重放到其他模型' });
      return undefined;
    }
    if (this.fallbackCount >= this.maxFallbacks) {
      this.routeEvents.push({ type: 'fallback_rejected', model: this.active.id, reason: '已达到模型切换次数上限' });
      return undefined;
    }
    const previous = this.active;
    const next = this.fallbackCandidates.find((profile) => this.allowFallbackTo(previous, profile, providerError));
    if (!next) {
      this.routeEvents.push({ type: 'fallback_rejected', model: previous.id, reason: '没有满足能力、隐私和健康约束的备用模型' });
      return undefined;
    }
    this.active = next;
    this.fallbackCandidates = this.fallbackCandidates.filter((profile) => profile.id !== next.id);
    this.fallbackCount += 1;
    this.routeEvents.push({
      type: 'fallback',
      fromModel: previous.id,
      toModel: next.id,
      reason: providerError.kind,
    });
    return next;
  }

  private allowFallbackTo(previous: ModelProfile, next: ModelProfile, error: ProviderError): boolean {
    if (next.privacy !== previous.privacy) return false;
    const health = this.health.get(next.id);
    if (health?.blockedUntil && health.blockedUntil > this.now()) return false;
    if (error.kind === 'context_length'
      && next.provider.capabilities.maxContextTokens <= previous.provider.capabilities.maxContextTokens) return false;
    return next.tier >= previous.tier || (this.allowTierDowngrade && next.tier === previous.tier - 1);
  }

  private recordSuccess(profile: ModelProfile): void {
    this.health.set(profile.id, { consecutiveFailures: 0 });
  }

  private recordFailure(profile: ModelProfile): void {
    const state = this.health.get(profile.id) ?? { consecutiveFailures: 0 };
    const consecutiveFailures = state.consecutiveFailures + 1;
    this.health.set(profile.id, {
      consecutiveFailures,
      blockedUntil: consecutiveFailures >= this.circuitFailureThreshold
        ? this.now() + this.circuitCooldownMs : undefined,
    });
  }

  private recordUsage(profile: ModelProfile, result: ProviderResult): void {
    const usage = result.usage;
    if (!usage || profile.estimatedInputCostPer1k === undefined || profile.estimatedOutputCostPer1k === undefined) {
      this.costUnknown = true;
      return;
    }
    const cost = usage.inputTokens / 1_000 * profile.estimatedInputCostPer1k
      + usage.outputTokens / 1_000 * profile.estimatedOutputCostPer1k;
    this.runCostUsd += cost;
    this.sessionCostUsd += cost;
  }
}

export function classifyTask(userMessage: string): TaskClassification {
  const message = userMessage.toLowerCase();
  const explanatory = /解释|说明|总结|摘要|翻译|explain|summari[sz]e|translate/.test(message);
  const complex = /架构|迁移|安全|漏洞|根因|重构|多文件|architecture|migrat|security|vulnerab|root cause|refactor/.test(message);
  const coding = /修复|调试|测试|实现|修改|代码|review|bug|debug|test|implement|edit|file/.test(message);
  const plan = /计划|方案|设计|plan|design/.test(message);
  const verify = /验证|测试|检查|verify|test|check/.test(message);
  if (explanatory && !/修复|修改|实现|调试|fix|implement|debug/.test(message)) {
    return { tier: 0, phase: 'execute', requiresTools: false, reason: '解释和摘要任务优先低延迟模型' };
  }
  if (complex) return { tier: 3, phase: plan ? 'plan' : verify ? 'verify' : 'execute', requiresTools: true, reason: '复杂代码任务需要高阶推理与工具能力' };
  if (coding) return { tier: 2, phase: verify ? 'verify' : plan ? 'plan' : 'execute', requiresTools: true, reason: '代码任务需要多轮工具能力' };
  if (userMessage.length > 1_200) return { tier: 1, phase: 'plan', requiresTools: false, reason: '长输入需要稳定上下文能力' };
  return { tier: 0, phase: 'execute', requiresTools: false, reason: '简单文本任务优先低延迟模型' };
}

function isUsable(
  profile: ModelProfile,
  classification: TaskClassification,
  requiredPrivacy: PrivacyLevel,
  health: ReadonlyMap<string, HealthState>,
  now: number,
): boolean {
  if (profile.privacy !== requiredPrivacy) return false;
  if (profile.tier < classification.tier) return false;
  if (classification.requiresTools && !profile.provider.capabilities.supportsToolCalls) return false;
  return !(health.get(profile.id)?.blockedUntil && health.get(profile.id)!.blockedUntil! > now);
}

function isFallbackUsable(
  profile: ModelProfile,
  classification: TaskClassification,
  requiredPrivacy: PrivacyLevel,
  health: ReadonlyMap<string, HealthState>,
  now: number,
): boolean {
  if (profile.privacy !== requiredPrivacy) return false;
  if (classification.requiresTools && !profile.provider.capabilities.supportsToolCalls) return false;
  return !(health.get(profile.id)?.blockedUntil && health.get(profile.id)!.blockedUntil! > now);
}

function candidateScore(profile: ModelProfile, classification: TaskClassification, mode: ModelRoutingMode): number {
  const tierDistance = profile.tier - classification.tier;
  const cost = (profile.estimatedInputCostPer1k ?? 1) + (profile.estimatedOutputCostPer1k ?? 1);
  const latency = profile.latencyHintMs ?? 1_000;
  if (mode === 'quality') return profile.tier * 1_000 - tierDistance * 10 - latency / 1_000;
  if (mode === 'fast') return -latency - cost * 10 + tierDistance;
  if (mode === 'privacy') return -cost * 100 - latency / 100;
  return -tierDistance * 40 - cost * 25 - latency / 1_000;
}

function fallbackAllowed(error: ProviderError): boolean {
  return error.kind === 'network' || error.kind === 'timeout' || error.kind === 'upstream'
    || error.kind === 'rate_limit' || error.kind === 'context_length';
}

function fallbackRejectionReason(error: ProviderError | undefined): string {
  if (!error) return '未知模型错误不自动切换';
  if (error.kind === 'cancelled') return '请求已取消';
  if (error.kind === 'content_filter') return '内容策略拒绝不切换模型';
  return `${error.kind} 错误不允许自动切换模型`;
}

function pinnedProfileId(mode: ModelRoutingMode): string | undefined {
  return mode.startsWith('pinned:') ? mode.slice('pinned:'.length) || undefined : undefined;
}

function routingMode(value: string): ModelRoutingMode {
  if (['off', 'auto', 'fast', 'balanced', 'quality', 'privacy'].includes(value)) return value as ModelRoutingMode;
  if (value.startsWith('pinned:') && /^[a-zA-Z0-9._-]+$/u.test(value.slice(7))) return value as ModelRoutingMode;
  throw new Error('模型模式无效');
}

function profileById(profiles: readonly ModelProfile[], id?: string): ModelProfile | undefined {
  return id ? profiles.find((profile) => profile.id === id) : undefined;
}

function assertProfiles(profiles: readonly ModelProfile[]): void {
  const ids = new Set<string>();
  for (const profile of profiles) {
    if (!/^[a-zA-Z0-9._-]+$/u.test(profile.id)) throw new Error(`模型 Profile ID 非法：${profile.id}`);
    if (!Number.isInteger(profile.tier) || profile.tier < 0 || profile.tier > 3) {
      throw new Error(`模型 Profile ${profile.id} 的 tier 必须是 0 到 3 的整数`);
    }
    if (ids.has(profile.id)) throw new Error(`模型 Profile ID 重复：${profile.id}`);
    ids.add(profile.id);
  }
}

export function latestUserText(items: readonly ConversationItem[]): string | undefined {
  const latest = items.findLast((item) => item.type === 'message' && item.role === 'user');
  return latest?.type === 'message' ? messageText(latest) : undefined;
}
