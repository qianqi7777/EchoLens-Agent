import {
  OpenAICompatibleProvider,
  textMessage,
  type ConversationItem,
  type OpenAICompatibleProtocol,
  type ToolCallItem,
  type ToolResultItem,
} from '../src/runtime/index.js';

const baseUrl = required('AGENT_VERIFY_BASE_URL');
const apiKey = required('AGENT_VERIFY_API_KEY');
const model = required('AGENT_VERIFY_MODEL');
const protocol = protocolValue(process.env.AGENT_VERIFY_PROTOCOL);
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

function protocolValue(value: string | undefined): OpenAICompatibleProtocol {
  if (value === 'responses') return 'responses';
  return 'chat_completions';
}
