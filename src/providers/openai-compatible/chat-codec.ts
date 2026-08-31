import { textMessage, type ConversationItem, type ToolCallItem } from '../../core/messages.js';
import type { ModelToolDefinition, ProviderRequest, ProviderResult } from '../types.js';
import { isRecord, nonNegativeNumber, stopReasonFromChat, toolCallItem } from './shared.js';
import type { EncodedProviderRequest, ProtocolCodec } from './types.js';

type ChatMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: ChatToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };

interface ChatToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

interface ChatCompletionPayload {
  id?: string;
  choices?: Array<{
    finish_reason?: string | null;
    message?: {
      content?: string | null;
      tool_calls?: Array<{
        id: string;
        type?: string;
        function: { name: string; arguments: string };
      }>;
    };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    prompt_cache_hit_tokens?: number;
  };
}

export class ChatCompletionsCodec implements ProtocolCodec {
  readonly protocol = 'chat_completions' as const;

  // Chat Completions 用 messages 数组承载对话；response_format 的 json_schema 需再包一层
  // json_schema 字段，与 Responses 的 text.format 结构不同（见 3.3 协议字段映射）。
  encode(model: string, request: ProviderRequest): EncodedProviderRequest {
    return {
      endpoint: '/chat/completions',
      body: {
        model,
        messages: encodeMessages(request.items),
        tools: request.tools?.map(encodeTool),
        response_format: request.responseFormat ? {
          type: 'json_schema',
          json_schema: {
            name: request.responseFormat.name,
            description: request.responseFormat.description,
            schema: request.responseFormat.schema,
            strict: request.responseFormat.strict,
          },
        } : undefined,
        stream: false,
      },
    };
  }

  decode(payload: unknown, requestId?: string): ProviderResult {
    const data = decodeChatPayload(payload);
    const choice = data.choices?.[0];
    const message = choice?.message;
    const calls = message?.tool_calls ?? [];
    const output = [
      textMessage(`chat-message-${data.id ?? requestId ?? 'unknown'}`, 'assistant', message?.content ?? ''),
      ...calls.map((call, index) => toolCallItem(
        `chat-tool-call-${call.id}`,
        call.id,
        call.function.name,
        call.function.arguments,
        index,
      )),
    ];
    const inputTokens = nonNegativeNumber(data.usage?.prompt_tokens) ?? 0;
    const outputTokens = nonNegativeNumber(data.usage?.completion_tokens) ?? 0;
    const totalTokens = nonNegativeNumber(data.usage?.total_tokens) ?? inputTokens + outputTokens;
    const cachedInputTokens = nonNegativeNumber(data.usage?.prompt_cache_hit_tokens);
    return {
      output,
      stopReason: stopReasonFromChat(choice?.finish_reason, calls.length > 0),
      requestId: requestId ?? data.id,
      usage: data.usage ? {
        inputTokens,
        outputTokens,
        totalTokens,
        cachedInputTokens,
      } : undefined,
      cache: cachedInputTokens === undefined ? undefined : { readTokens: cachedInputTokens },
    };
  }
}

// 网络响应不可信：先校验 choices / message / tool_calls 结构，非法即抛错，避免污染内部结果。
function decodeChatPayload(payload: unknown): ChatCompletionPayload {
  if (!isRecord(payload) || !Array.isArray(payload.choices) || payload.choices.length === 0) {
    throw new Error('Chat Completions 响应缺少 choices');
  }
  const choice = payload.choices[0];
  if (!isRecord(choice) || !isRecord(choice.message)) {
    throw new Error('Chat Completions 响应缺少 assistant message');
  }
  const content = choice.message.content;
  if (content !== undefined && content !== null && typeof content !== 'string') {
    throw new Error('Chat Completions message content 类型无效');
  }
  const calls = choice.message.tool_calls;
  if (calls !== undefined) {
    if (!Array.isArray(calls)) throw new Error('Chat Completions tool_calls 类型无效');
    for (const call of calls) {
      if (!isRecord(call) || typeof call.id !== 'string' || !isRecord(call.function)
        || typeof call.function.name !== 'string' || typeof call.function.arguments !== 'string') {
        throw new Error('Chat Completions tool call 结构无效');
      }
    }
  }
  return payload as unknown as ChatCompletionPayload;
}

// Chat Completions 约定：tool 结果须跟在携带对应 tool_calls 的 assistant 消息之后，
// 同一轮并行的多次工具调用必须合并进同一条 assistant 消息，不能拆成多条。
// 因此这里把 assistant 消息与其后连续的工具调用合并；对无 assistant 前缀的连续工具调用，
// 也归并成一条 assistant 消息，避免 Provider 因工具调用归属不明而拒绝请求。
function encodeMessages(items: ConversationItem[]): ChatMessage[] {
  const messages: ChatMessage[] = [];
  let index = 0;
  while (index < items.length) {
    const item = items[index]!;
    if (item.type === 'message') {
      const content = item.content.map((part) => part.text).join('');
      if (item.role !== 'assistant') {
        messages.push({ role: item.role, content });
        index += 1;
        continue;
      }
      const toolCalls: ChatToolCall[] = [];
      let next = index + 1;
      while (next < items.length && items[next]?.type === 'tool_call') {
        toolCalls.push(encodeToolCall(items[next] as ToolCallItem));
        next += 1;
      }
      messages.push({
        role: 'assistant',
        content: content || null,
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      });
      index = next;
      continue;
    }
    if (item.type === 'tool_call') {
      const calls: ChatToolCall[] = [encodeToolCall(item)];
      let next = index + 1;
      while (next < items.length && items[next]?.type === 'tool_call') {
        calls.push(encodeToolCall(items[next] as ToolCallItem));
        next += 1;
      }
      messages.push({ role: 'assistant', content: null, tool_calls: calls });
      index = next;
      continue;
    }
    messages.push({ role: 'tool', tool_call_id: item.callId, content: item.output.content });
    index += 1;
  }
  return messages;
}

function encodeToolCall(call: ToolCallItem): ChatToolCall {
  return {
    id: call.callId,
    type: 'function',
    function: {
      name: call.name,
      arguments: call.rawArguments ?? JSON.stringify(call.arguments),
    },
  };
}

// Chat Completions 的 tools 项需用 function 包裹一层 {type:'function',function:{name,...}}，
// 与 Responses 的扁平 tools 结构不同。
function encodeTool(tool: ModelToolDefinition) {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  };
}
