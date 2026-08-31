// Provider 连通性验证脚本：用真实模型跑一次“强制工具调用 → 回填结果 → 收尾”的两轮对话。
// 只输出结构化 JSON 摘要（协议、停止原因、是否含 requestId/usage），用于人工或 CI 确认
// 某个 baseUrl/apiKey/model/protocol 组合可用。需要 AGENT_VERIFY_* 环境变量。
import {
  OpenAICompatibleProvider,
  textMessage,
  type ConversationItem,
  type OpenAICompatibleProtocol,
  type ToolCallItem,
  type ToolResultItem,
} from '../src/runtime/index.js';

// 凭据只从环境变量读取，脚本本身不接受命令行参数，避免凭据进 shell 历史。
const baseUrl = required('AGENT_VERIFY_BASE_URL');
const apiKey = required('AGENT_VERIFY_API_KEY');
const model = required('AGENT_VERIFY_MODEL');
const protocol = protocolValue(process.env.AGENT_VERIFY_PROTOCOL);
// 置 1 时把“第一轮必须产出工具调用”当作失败条件，用于验证 tool calling 能力。
const requireToolCall = process.env.AGENT_VERIFY_REQUIRE_TOOL_CALL === '1';

const provider = new OpenAICompatibleProvider({
  baseUrl,
  apiKey,
  model,
  protocol,
});

const firstItems: ConversationItem[] = [
  textMessage(
    'verify-user',
    'user',
    'You must call read_file exactly once with {"path":"README.md"} before answering. Do not answer from memory.',
  ),
];
const tools = [{
  name: 'read_file',
  description: 'Read a file from the workspace.',
  parameters: {
    type: 'object' as const,
    properties: { path: { type: 'string' } },
    required: ['path'],
    additionalProperties: false,
  },
}];

const first = await provider.complete({ items: firstItems, tools });
const toolCalls = first.output.filter((item): item is ToolCallItem => item.type === 'tool_call');
if (requireToolCall && toolCalls.length === 0) {
  throw new Error('Provider did not return the required tool call.');
}

// 有工具调用就进入第二轮：把工具结果回填后确认 Provider 还能产出最终消息，
// 这一轮同时验证多轮对话与 tool result 回填的协议路径。
let finalStopReason = first.stopReason;
if (toolCalls.length > 0) {
  const results = toolCalls.map(toolResult);
  const second = await provider.complete({
    items: [...firstItems, ...first.output, ...results],
    tools,
  });
  finalStopReason = second.stopReason;
  if (!second.output.some((item) => item.type === 'message')) {
    throw new Error('Provider did not return a final assistant message.');
  }
}

// 摘要不含任何消息正文，只含元数据；凭据永不输出。
console.log(JSON.stringify({
  ok: true,
  protocol,
  model,
  toolCalls: toolCalls.length,
  firstStopReason: first.stopReason,
  finalStopReason,
  requestIdPresent: Boolean(first.requestId),
  usagePresent: Boolean(first.usage),
}));

function toolResult(call: ToolCallItem, index: number): ToolResultItem {
  return {
    type: 'tool_result',
    id: `verify-result-${index}`,
    callId: call.callId,
    toolName: call.name,
    status: 'ok',
    output: {
      id: `verify-context-${index}`,
      kind: 'tool_output',
      content: '# EchoLens Agent\nA TypeScript coding agent runtime.',
      source: { type: 'tool', toolCallId: call.callId, toolName: call.name },
      trust: 'untrusted',
      redactions: [],
    },
    summary: 'read_file README.md',
    evidenceIds: ['file:README.md:1'],
  };
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
}

// 未指定时默认走 chat_completions：它是兼容面最广的协议，responses 需要显式声明。
function protocolValue(value: string | undefined): OpenAICompatibleProtocol {
  if (value === 'responses') return 'responses';
  return 'chat_completions';
}
