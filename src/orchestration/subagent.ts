import type { ModelProvider } from '../providers/types.js';
import type { AgentEvent } from '../session/events.js';
import {
  CODE_INTELLIGENCE_TOOL_NAMES,
  CodeIntelligenceService,
  registerCodeIntelligenceTools,
} from '../code-intelligence/index.js';
import {
  DefaultProposedActionGuardrail,
  type ProposedActionDecision,
  type ProposedActionGuardrail,
} from '../runtime/action-guardrail.js';
import { ReactAgent } from '../runtime/react-loop.js';
import { toolSuccess } from '../runtime/tool-result.js';
import { ToolExecutor } from '../runtime/tool-executor.js';
import { ToolRegistry } from '../runtime/tool-registry.js';
import type { Permission, ToolContext, ToolSpec } from '../runtime/types.js';
import type { BackgroundTaskIsolation } from './task-queue.js';
import {
  DefaultTaskWorkspaceAllocator,
  type TaskWorkspaceAllocator,
} from './workspace-allocator.js';

export type BuiltinSubagentProfile = 'explore' | 'test' | 'review';

export interface SubagentProfile {
  id: string;
  description: string;
  tools: ReadonlySet<string>;
  permissions: ReadonlySet<Permission>;
  maxSteps: number;
  maxToolCalls: number;
  workspaceMode: BackgroundTaskIsolation;
  autoApproveEffects: ReadonlySet<NonNullable<ToolSpec['effect']>>;
}

export interface SubagentRequest {
  profile: string;
  objective: string;
  workspaceMode?: BackgroundTaskIsolation;
}

export interface SubagentResult {
  schemaVersion: 1;
  profile: string;
  workspaceMode: BackgroundTaskIsolation;
  state: 'completed' | 'paused' | 'cancelled' | 'failed';
  summary: string;
  changedFiles: string[];
  tests: Array<{ command: string; status: string; summary: string }>;
  unresolved: string[];
  evidenceIds: string[];
  metrics: { modelSteps: number; toolCalls: number; inputTokens: number; outputTokens: number };
}

export interface SubagentRegistryLease {
  registry: ToolRegistry;
  close(): Promise<void>;
}

export type SubagentRegistryFactory = (
  workspaceRoot: string,
  profileDefinition: SubagentProfile,
  sourceRegistry: ToolRegistry,
) => Promise<SubagentRegistryLease>;

const READ_TOOLS = [
  'read_file', 'grep', 'list_files',
  'outline_file', 'find_symbols', 'go_to_definition', 'find_references', 'get_diagnostics',
];
const CODE_INTELLIGENCE_TOOLS = new Set<string>(CODE_INTELLIGENCE_TOOL_NAMES);

export const BUILTIN_SUBAGENT_PROFILES: Readonly<Record<BuiltinSubagentProfile, SubagentProfile>> = {
  explore: profile('explore', '只读探索代码、符号和依赖关系', READ_TOOLS, ['workspace.read'], 8, 16, 'sandbox', ['read']),
  test: profile('test', '只读分析并在 Sandbox 中运行受控测试', [...READ_TOOLS, 'run_tests', 'verify_changes'], ['workspace.read', 'process.exec'], 8, 12, 'sandbox', ['read', 'process']),
  review: profile('review', '只读审查风险、回归和测试缺口', READ_TOOLS, ['workspace.read'], 10, 20, 'sandbox', ['read']),
};

export class SubagentOrchestrator {
  private readonly profiles = new Map<string, SubagentProfile>();

  constructor(
    private readonly model: ModelProvider,
    private readonly sourceRegistry: ToolRegistry,
    private readonly workspaceRoot: string,
    private readonly allocator: TaskWorkspaceAllocator = new DefaultTaskWorkspaceAllocator(),
    profiles: readonly SubagentProfile[] = Object.values(BUILTIN_SUBAGENT_PROFILES),
    private readonly registryFactory: SubagentRegistryFactory = createWorkspaceBoundSubagentRegistry,
  ) {
    for (const current of profiles) this.profiles.set(current.id, current);
  }

  listProfiles(): SubagentProfile[] {
    return [...this.profiles.values()].map((current) => ({
      ...current,
      tools: new Set(current.tools),
      permissions: new Set(current.permissions),
      autoApproveEffects: new Set(current.autoApproveEffects),
    }));
  }

  async run(request: SubagentRequest, signal = new AbortController().signal): Promise<SubagentResult> {
    const profileDefinition = this.profiles.get(request.profile);
    if (!profileDefinition) throw new Error(`未知子 Agent Profile：${request.profile}`);
    const objective = request.objective.trim();
    if (!objective || objective.length > 50_000) throw new Error('子 Agent 目标无效');
    const workspaceMode = request.workspaceMode ?? profileDefinition.workspaceMode;
    const lease = await this.allocator.allocate(this.workspaceRoot, workspaceMode);
    const events: AgentEvent[] = [];
    let registryLease: SubagentRegistryLease | undefined;
    try {
      registryLease = await this.registryFactory(lease.root, profileDefinition, this.sourceRegistry);
      const { registry } = registryLease;
      const executor = new ToolExecutor(registry, {
        maxCalls: profileDefinition.maxToolCalls,
        timeoutMs: 120_000,
        actionGuardrail: new DelegatedProfileGuardrail(profileDefinition),
      });
      const agent = new ReactAgent(this.model, registry, executor, {
        workspaceRoot: lease.root,
        permissions: profileDefinition.permissions,
        maxSteps: profileDefinition.maxSteps,
        privacy: 'full-context',
      });
      const result = await agent.run(subagentPrompt(profileDefinition, objective), [], signal, {
        onEvent: (event) => { events.push(event); },
      });
      const changedFiles = workspaceMode === 'worktree' ? await lease.changedFiles() : [];
      const summary = result.finalSummary.verified ? result.finalSummary.value : undefined;
      return {
        schemaVersion: 1,
        profile: profileDefinition.id,
        workspaceMode,
        state: result.state === 'completed' || result.state === 'paused' || result.state === 'cancelled' ? result.state : 'failed',
        summary: (summary?.answer ?? result.answer).slice(0, 20_000),
        changedFiles,
        tests: summary?.verification.map((item) => ({
          command: item.command,
          status: item.status,
          summary: item.summary,
        })) ?? [],
        unresolved: summary?.unresolved ?? (result.degraded ? ['子 Agent 未正常完成'] : []),
        evidenceIds: evidenceIds(result.items),
        metrics: metrics(events),
      };
    } finally {
      await registryLease?.close().catch(() => undefined);
      await lease.cleanup();
    }
  }
}

export async function createWorkspaceBoundSubagentRegistry(
  workspaceRoot: string,
  profileDefinition: SubagentProfile,
  sourceRegistry: ToolRegistry,
): Promise<SubagentRegistryLease> {
  const available = new Set(sourceRegistry.list().map((tool) => tool.name));
  const missing = [...profileDefinition.tools].filter((name) => !available.has(name));
  if (missing.length) throw new Error(`子 Agent 工具未注册：${missing.join(', ')}`);

  const reusableTools = new Set([...profileDefinition.tools].filter((name) => !CODE_INTELLIGENCE_TOOLS.has(name)));
  const registry = sourceRegistry.subset(reusableTools);
  const requestedCodeTools = [...profileDefinition.tools].filter((name) => CODE_INTELLIGENCE_TOOLS.has(name));
  if (requestedCodeTools.length === 0) {
    return { registry, close: async () => undefined };
  }

  const codeIntelligence = new CodeIntelligenceService(workspaceRoot);
  try {
    const codeRegistry = new ToolRegistry();
    registerCodeIntelligenceTools(codeRegistry, codeIntelligence);
    for (const name of requestedCodeTools) registry.register(codeRegistry.get(name));
    return { registry, close: () => codeIntelligence.close() };
  } catch (error) {
    await codeIntelligence.close().catch(() => undefined);
    throw error;
  }
}

export function registerSubagentTool(registry: ToolRegistry, orchestrator: SubagentOrchestrator): void {
  registry.register({
    name: 'delegate_task',
    description: '把独立的探索、测试或审查任务委托给受限子 Agent；子 Agent 只有固定工具白名单和独立预算。',
    permission: 'external.invoke',
    effect: 'external',
    inputSchema: {
      type: 'object',
      properties: {
        profile: { type: 'string', enum: ['explore', 'test', 'review'] },
        objective: { type: 'string', minLength: 1, maxLength: 50_000 },
        isolation: { type: 'string', enum: ['sandbox', 'worktree'] },
      },
      required: ['profile', 'objective'],
      additionalProperties: false,
    },
    execute: async (args, context) => {
      const result = await orchestrator.run({
        profile: String(args.profile),
        objective: String(args.objective),
        workspaceMode: args.isolation === 'worktree' || args.isolation === 'sandbox' ? args.isolation : undefined,
      }, context.signal);
      return toolSuccess(
        result.summary,
        `子 Agent ${result.profile}：${result.state}`,
        result.evidenceIds,
        { subagent: result },
      );
    },
  });
}

class DelegatedProfileGuardrail implements ProposedActionGuardrail {
  private readonly base = new DefaultProposedActionGuardrail();

  constructor(private readonly profileDefinition: SubagentProfile) {}

  async evaluate(tool: ToolSpec, args: Record<string, unknown>, context: ToolContext): Promise<ProposedActionDecision> {
    if (!this.profileDefinition.tools.has(tool.name)) {
      return { decision: 'deny', reasonCode: 'subagent_tool_denied', reason: '子 Agent 工具不在 Profile 白名单', normalizedArguments: structuredClone(args) };
    }
    const decision = await this.base.evaluate(tool, args, context);
    if (decision.decision !== 'require_approval' || decision.reasonCode !== 'approval_required') return decision;
    const effect = tool.effect ?? 'external';
    return this.profileDefinition.autoApproveEffects.has(effect)
      ? { ...decision, decision: 'allow', reasonCode: 'delegated_profile_allow', reason: '用户批准的委托 Profile 允许该受限动作' }
      : decision;
  }
}

function profile(
  id: string,
  description: string,
  tools: string[],
  permissions: Permission[],
  maxSteps: number,
  maxToolCalls: number,
  workspaceMode: BackgroundTaskIsolation,
  autoApproveEffects: Array<NonNullable<ToolSpec['effect']>>,
): SubagentProfile {
  return {
    id,
    description,
    tools: new Set(tools),
    permissions: new Set(permissions),
    maxSteps,
    maxToolCalls,
    workspaceMode,
    autoApproveEffects: new Set(autoApproveEffects),
  };
}

function subagentPrompt(profileDefinition: SubagentProfile, objective: string): string {
  return [
    `你是受限的 ${profileDefinition.id} 子 Agent。`,
    profileDefinition.description,
    '只处理下述目标，不扩展范围。所有结论必须引用工具返回的 evidence ID；无法证明时列入 unresolved。',
    `目标：${objective}`,
  ].join('\n');
}

function evidenceIds(items: readonly { type: string; evidenceIds?: string[] }[]): string[] {
  return [...new Set(items.flatMap((item) => item.type === 'tool_result' ? item.evidenceIds ?? [] : []))];
}

function metrics(events: readonly AgentEvent[]): SubagentResult['metrics'] {
  let inputTokens = 0;
  let outputTokens = 0;
  for (const event of events) {
    if (event.payload.type !== 'usage.recorded') continue;
    inputTokens += event.payload.usage.inputTokens;
    outputTokens += event.payload.usage.outputTokens;
  }
  return {
    modelSteps: events.filter((event) => event.payload.type === 'model.started').length,
    toolCalls: events.filter((event) => event.payload.type === 'tool.completed').length,
    inputTokens,
    outputTokens,
  };
}
