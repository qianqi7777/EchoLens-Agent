import type { AgentTraceItem, ChatMessage, ChatModel, ModelToolDefinition } from './types.js';
import { ToolExecutor } from './tool-executor.js';
import { ToolRegistry } from './tool-registry.js';
import type { Permission, ToolContext } from './types.js';

export interface AgentRunResult {
  answer: string;
  messages: ChatMessage[];
  trace: AgentTraceItem[];
  degraded: boolean;
}

/**
 * 最小 ReAct 回合：模型决定是否调用工具，工具结果回填 messages，直到模型给出最终答案。
 * 这是一个可替换的工作流实现，不把 Session、权限或工具安全塞进模型框架 State。
 */
export class ReactAgent {
  constructor(
    private readonly model: ChatModel,
    private readonly registry: ToolRegistry,
    private readonly executor: ToolExecutor,
    private readonly options: { maxSteps?: number; workspaceRoot: string; permissions?: ReadonlySet<Permission> },
  ) {}

  async run(userMessage: string, history: ChatMessage[] = [], signal?: AbortSignal): Promise<AgentRunResult> {
    const messages: ChatMessage[] = [...history.slice(-12), { role: 'user', content: userMessage }];
    const trace: AgentTraceItem[] = [];
    const tools: ModelToolDefinition[] = this.registry.list().map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.inputSchema }));
    const context: ToolContext = { workspaceRoot: this.options.workspaceRoot, allowedPermissions: this.options.permissions ?? new Set(['workspace.read']), signal: signal ?? new AbortController().signal };
    this.executor.resetBudget();

    for (let step = 0; step < (this.options.maxSteps ?? 8); step += 1) {
      const response = await this.model.complete({ messages, tools, signal });
      trace.push({ type: 'model', message: response.toolCalls.length ? `模型请求 ${response.toolCalls.length} 个工具` : '模型生成最终回答' });
      if (!response.toolCalls.length) return { answer: response.text, messages, trace, degraded: false };

      messages.push({ role: 'assistant', content: response.text, toolCalls: response.toolCalls });
      for (const call of response.toolCalls) {
        const result = await this.executor.invoke(call.name, call.arguments, context);
        messages.push({ role: 'tool', toolCallId: call.id, toolName: call.name, content: result.content });
        trace.push({ type: 'tool', message: `${call.name}: ${result.summary}` });
      }
    }
    return { answer: '已达到 Agent 步骤预算，以上工具结果仍需人工核查。', messages, trace, degraded: true };
  }
}

