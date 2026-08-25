import type {
  ProviderResult,
  ProviderStreamEvent,
  TokenUsage,
} from '../types.js';
import { ChatCompletionsCodec } from './chat-codec.js';
import { ResponsesCodec } from './responses-codec.js';
import { isRecord, nonNegativeNumber } from './shared.js';
import type { OpenAICompatibleProtocol } from './types.js';
import type { SseRecord } from './sse.js';

export async function* decodeProviderStream(
  protocol: OpenAICompatibleProtocol,
  records: AsyncIterable<SseRecord>,
  requestId?: string,
): AsyncGenerator<ProviderStreamEvent> {
  if (protocol === 'chat_completions') {
    yield* decodeChatStream(records, requestId);
    return;
  }
  yield* decodeResponsesStream(records, requestId);
}

async function* decodeChatStream(
  records: AsyncIterable<SseRecord>,
  requestId?: string,
): AsyncGenerator<ProviderStreamEvent> {
  let id = requestId;
  let text = '';
  let finishReason: string | null | undefined;
  let usage: TokenUsage | undefined;
  const calls = new Map<number, { id: string; name: string; arguments: string }>();
  let completed = false;

  for await (const record of records) {
    if (record.data === '[DONE]') {
      completed = true;
      break;
    }
    const chunk = parseJson(record.data, 'Chat Completions SSE data');
    if (!isRecord(chunk)) throw new Error('Chat Completions SSE chunk 结构无效');
    if (typeof chunk.id === 'string') id = chunk.id;
    usage = decodeChatUsage(chunk.usage) ?? usage;
    if (!Array.isArray(chunk.choices) || chunk.choices.length === 0) continue;
    const choice = chunk.choices[0];
    if (!isRecord(choice)) throw new Error('Chat Completions SSE choice 结构无效');
    if (typeof choice.finish_reason === 'string' || choice.finish_reason === null) {
      finishReason = choice.finish_reason as string | null;
    }
    if (!isRecord(choice.delta)) continue;
    if (typeof choice.delta.content === 'string' && choice.delta.content) {
      text += choice.delta.content;
      yield { type: 'output_text.delta', delta: choice.delta.content };
    }
    if (Array.isArray(choice.delta.tool_calls)) {
      for (const raw of choice.delta.tool_calls) mergeToolCall(calls, raw);
    }
  }
  if (!completed && finishReason === undefined) throw new Error('Chat Completions SSE 未正常结束');
  const payload = {
    id,
    choices: [{
      finish_reason: finishReason,
      message: {
        role: 'assistant',
        content: text,
        tool_calls: [...calls.entries()].sort(([left], [right]) => left - right).map(([, call]) => ({
          id: call.id,
          type: 'function',
          function: { name: call.name, arguments: call.arguments },
        })),
      },
    }],
    usage: usage ? {
      prompt_tokens: usage.inputTokens,
      completion_tokens: usage.outputTokens,
      total_tokens: usage.totalTokens,
      prompt_cache_hit_tokens: usage.cachedInputTokens,
    } : undefined,
  };
  const result = new ChatCompletionsCodec().decode(payload, requestId ?? id);
  yield { type: 'response.completed', result };
}

async function* decodeResponsesStream(
  records: AsyncIterable<SseRecord>,
  requestId?: string,
): AsyncGenerator<ProviderStreamEvent> {
  let terminal: ProviderResult | undefined;
  for await (const record of records) {
    if (record.data === '[DONE]') break;
    const event = parseJson(record.data, 'Responses SSE data');
    if (!isRecord(event)) throw new Error('Responses SSE event 结构无效');
    const type = typeof event.type === 'string' ? event.type : record.event;
    if (type === 'response.output_text.delta' && typeof event.delta === 'string') {
      yield { type: 'output_text.delta', delta: event.delta };
    }
    if (type === 'response.completed' || type === 'response.failed'
      || type === 'response.incomplete') {
      const response = isRecord(event.response) ? event.response : event;
      terminal = new ResponsesCodec().decode(response, requestId);
    }
  }
  if (!terminal) throw new Error('Responses SSE 缺少终止事件');
  yield { type: 'response.completed', result: terminal };
}

function mergeToolCall(
  calls: Map<number, { id: string; name: string; arguments: string }>,
  raw: unknown,
): void {
  if (!isRecord(raw) || !Number.isInteger(raw.index)) {
    throw new Error('Chat Completions SSE tool_call 缺少 index');
  }
  const index = raw.index as number;
  const current = calls.get(index) ?? { id: '', name: '', arguments: '' };
  if (typeof raw.id === 'string') current.id = raw.id;
  if (isRecord(raw.function)) {
    if (typeof raw.function.name === 'string') current.name += raw.function.name;
    if (typeof raw.function.arguments === 'string') current.arguments += raw.function.arguments;
  }
  if (!current.id) current.id = `stream-call-${index}`;
  calls.set(index, current);
}

function decodeChatUsage(value: unknown): TokenUsage | undefined {
  if (!isRecord(value)) return undefined;
  const inputTokens = nonNegativeNumber(value.prompt_tokens) ?? 0;
  const outputTokens = nonNegativeNumber(value.completion_tokens) ?? 0;
  const totalTokens = nonNegativeNumber(value.total_tokens) ?? inputTokens + outputTokens;
  return {
    inputTokens,
    outputTokens,
    totalTokens,
    cachedInputTokens: nonNegativeNumber(value.prompt_cache_hit_tokens),
  };
}

function parseJson(value: string, label: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`${label} 不是合法 JSON`);
  }
}
