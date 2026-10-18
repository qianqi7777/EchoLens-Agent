import { textMessage, type ToolCallItem } from '../../../src/core/messages.js';
import type { ModelProvider } from '../../../src/providers/types.js';
import { ReactAgent } from '../../../src/runtime/resumable-react-agent.js';
import { ToolExecutor } from '../../../src/runtime/tool-executor.js';
import { ToolRegistry } from '../../../src/runtime/tool-registry.js';
import { registerWorkspaceTools } from '../../../src/runtime/workspace-tools.js';
import type { StructuredPatch } from '../../../src/runtime/structured-patch.js';
import type { AgentEvent } from '../../../src/session/events.js';
import type { EvalCandidateRunner } from './types.js';

/** Local reference scripts exercise the production loop; they do not measure model quality. */
export function runtimeCandidate(value: unknown): EvalCandidateRunner {
  const script = value as { calls?: unknown } | null;
  if (!script || !Array.isArray(script.calls) || script.calls.length < 1 || script.calls.length > 8) {
    throw new Error('Runtime Candidate 必须提供 1–8 个工具调用');
  }
  const calls: ToolCallItem[] = script.calls.map((value: unknown, index: number) => {
    const call = value as { name?: unknown; arguments?: unknown } | null;
    if (!call || typeof call.name !== 'string' || !/^[a-z_]{1,64}$/u.test(call.name)
      || !call.arguments || typeof call.arguments !== 'object' || Array.isArray(call.arguments)) {
      throw new Error('Runtime Candidate 工具调用无效');
    }
    return { type: 'tool_call', id: `script-${index}`, callId: `script-${index}`,
      callIndex: 0, name: call.name, arguments: structuredClone(call.arguments as Record<string, unknown>) };
  });
  return {
    async run(task, workspaceRoot, signal) {
      let step = 0;
      const events: AgentEvent[] = [];
      const provider: ModelProvider = {
        model: 'local-scripted-provider',
        capabilities: { maxContextTokens: 32_768, supportsStreaming: false, supportsToolCalls: true,
          supportsParallelToolCalls: false, supportsStructuredOutput: false, supportsPromptCaching: false, supportsUsageReporting: false },
        async complete() {
          const call = calls[step++];
          return call ? { output: [textMessage(`assistant-${step}`, 'assistant', ''), call], stopReason: 'tool_calls' }
            : { output: [textMessage('final', 'assistant', '本地参考脚本执行结束')], stopReason: 'completed' };
        },
      };
      const registry = new ToolRegistry();
      registerWorkspaceTools(registry);
      const agent = new ReactAgent(provider, registry, new ToolExecutor(registry, {
        approvalDecider: async () => ({ decision: 'allow', scope: 'once', decidedAt: new Date().toISOString() }),
      }), { workspaceRoot, permissions: new Set(['workspace.read', 'workspace.write']),
        maxSteps: calls.length + 2, navigationMode: 'off', verificationGate: 'off' });
      const result = await agent.run(task.prompt, [], signal, { onEvent: (event) => { events.push(event); } });
      const successful = new Set(result.items.flatMap((item) => item.type === 'tool_result' && item.status === 'ok' ? [item.callId] : []));
      const operations = calls.flatMap((call) => call.name === 'apply_patch' && successful.has(call.callId)
        ? ((call.arguments.patch as StructuredPatch).operations ?? []) : []);
      return { events, ...(operations.length ? { patch: { version: 1 as const, operations } } : {}),
        metadata: { candidateMode: 'runtime-scripted', runState: result.state } };
    },
  };
}
