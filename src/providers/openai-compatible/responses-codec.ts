import { textMessage, type ConversationItem } from '../../core/messages.js';
import type { ModelToolDefinition, ProviderRequest, ProviderResult, ProviderStopReason } from '../types.js';
import { isRecord, nonNegativeNumber, toolCallItem } from './shared.js';
import type { EncodedProviderRequest, ProtocolCodec } from './types.js';

interface ResponsesPayload {
  id?: string;
  status?: 'completed' | 'failed' | 'in_progress' | 'cancelled' | 'queued' | 'incomplete';
  error?: { code?: string; message?: string } | null;
  incomplete_details?: { reason?: string } | null;
  output?: Array<Record<string, unknown>>;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
    input_tokens_details?: { cached_tokens?: number };
  };
}

/**
 * OpenAI Responses 协议编解码。
 *
 * 与 Chat Completions 的关键差异：input 是扁平数组、停止原因来自 status 字段、
 * 请求默认不落盘（store:false）。字段映射与停止原因分类见函数内注释。
 */
export class ResponsesCodec implements ProtocolCodec {
  readonly protocol = 'responses' as const;

  // Responses 把整段对话历史放进扁平的 input 数组，用 type 区分 message / function_call /
  // function_call_output；与 Chat Completions 的 messages 结构不同，各 codec 须分别适配。
  encode(model: string, request: ProviderRequest): EncodedProviderRequest {
    return {
      endpoint: '/responses',
      body: {
        model,
        input: encodeInput(request.items),
        tools: request.tools?.map(encodeTool),
        text: request.responseFormat ? {
          format: {
            type: 'json_schema',
            name: request.responseFormat.name,
            description: request.responseFormat.description,
            schema: request.responseFormat.schema,
            strict: request.responseFormat.strict,
          },
        } : undefined,
        // store: false：Responses API 默认在服务端保存会话，这里关闭持久化为无状态请求，
        // 避免 Provider 留存对话数据，并让重试可安全重放。
        store: false,
        stream: false,
      },
    };
  }

  decode(payload: unknown, requestId?: string): ProviderResult {
    const data = decodeResponsesPayload(payload);
    const output: ProviderResult['output'] = [];
    // callIndex 按 Provider 返回的工具调用顺序递增；工具结果必须按此顺序回填，
    // 即使并行工具完成顺序不同也不得打乱 callIndex，否则消息序列不稳定。
    let callIndex = 0;
    for (const item of data.output ?? []) {
      if (isResponseMessage(item)) {
        const text = item.content
          .map((part) => (
            typeof part.text === 'string' ? part.text
              : typeof part.refusal === 'string' ? part.refusal : ''
          ))
          .join('');
        output.push(textMessage(item.id ?? `response-message-${data.id ?? 'unknown'}`, 'assistant', text));
      } else if (isFunctionCall(item)) {
        const callId = item.call_id ?? item.id!;
        output.push(toolCallItem(
          item.id ?? `response-tool-call-${callId}`,
          callId,
          item.name!,
          item.arguments!,
          callIndex,
        ));
        callIndex += 1;
      }
    }
    const inputTokens = nonNegativeNumber(data.usage?.input_tokens) ?? 0;
    const outputTokens = nonNegativeNumber(data.usage?.output_tokens) ?? 0;
    const totalTokens = nonNegativeNumber(data.usage?.total_tokens) ?? inputTokens + outputTokens;
    const cachedInputTokens = nonNegativeNumber(data.usage?.input_tokens_details?.cached_tokens);
    return {
      output,
      stopReason: responseStopReason(data, callIndex > 0),
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

// Provider 响应不可信：转译为内部消息或工具调用前先校验结构与 status，任意不符立即抛错，
// 防止畸形 payload 流入后续工具执行流程。
function decodeResponsesPayload(payload: unknown): ResponsesPayload {
  if (!isRecord(payload) || !isResponseStatus(payload.status)) {
    throw new Error('Responses 响应缺少合法 status');
  }
  if (payload.output !== undefined
    && (!Array.isArray(payload.output) || payload.output.some((item) => !isRecord(item)))) {
    throw new Error('Responses output 结构无效');
  }
  if (payload.status === 'completed' && !Array.isArray(payload.output)) {
    throw new Error('已完成的 Responses 响应缺少 output');
  }
  for (const item of payload.output ?? []) {
    if (item.type === 'message') {
      if (!Array.isArray(item.content) || item.content.some((part: unknown) => !isRecord(part))) {
        throw new Error('Responses message content 结构无效');
      }
    }
    if (item.type === 'function_call'
      && ((typeof item.call_id !== 'string' && typeof item.id !== 'string')
        || typeof item.name !== 'string' || typeof item.arguments !== 'string')) {
      throw new Error('Responses function_call 结构无效');
    }
  }
  return payload as unknown as ResponsesPayload;
}

interface ResponseMessageItem extends Record<string, unknown> {
  type: 'message';
  id?: string;
  content: Array<{ type?: string; text?: string; refusal?: string }>;
}

interface ResponseFunctionCallItem extends Record<string, unknown> {
  type: 'function_call';
  id?: string;
  call_id?: string;
  name?: string;
  arguments?: string;
}

function isResponseMessage(item: Record<string, unknown>): item is ResponseMessageItem {
  return item.type === 'message' && Array.isArray(item.content);
}

function isFunctionCall(item: Record<string, unknown>): item is ResponseFunctionCallItem {
  return item.type === 'function_call';
}

function isResponseStatus(value: unknown): value is NonNullable<ResponsesPayload['status']> {
  return typeof value === 'string' && [
    'completed',
    'failed',
    'in_progress',
    'cancelled',
    'queued',
    'incomplete',
  ].includes(value);
}

function encodeInput(items: ConversationItem[]): Array<Record<string, unknown>> {
  return items.map((item) => {
    if (item.type === 'message') {
      return {
        type: 'message',
        role: item.role,
        content: item.content.map((part) => part.text).join(''),
      };
    }
    if (item.type === 'tool_call') {
      return {
        type: 'function_call',
        call_id: item.callId,
        name: item.name,
        arguments: item.rawArguments ?? JSON.stringify(item.arguments),
      };
    }
    return {
      type: 'function_call_output',
      call_id: item.callId,
      output: item.output.content,
    };
  });
}

function encodeTool(tool: ModelToolDefinition) {
  return {
    type: 'function',
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  };
}

// 停止原因映射即重试安全的关键：queued/in_progress 表示请求尚未就绪，重试可能成功；
// incomplete 仅在 max_output_tokens 截断时视为 truncated，其余 incomplete 按 fatal_error 处理，
// 避免把未完成响应误当作成功返回。
function responseStopReason(data: ResponsesPayload, hasToolCalls: boolean): ProviderStopReason {
  if (hasToolCalls) return 'tool_calls';
  if (data.status === 'cancelled') return 'cancelled';
  if (data.status === 'failed' || data.error) return 'fatal_error';
  if (data.status === 'queued' || data.status === 'in_progress') return 'retryable_error';
  if (data.status === 'incomplete') {
    return data.incomplete_details?.reason === 'max_output_tokens' ? 'truncated' : 'fatal_error';
  }
  return 'completed';
}
