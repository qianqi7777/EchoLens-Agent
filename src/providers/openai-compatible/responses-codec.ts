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

export class ResponsesCodec implements ProtocolCodec {
  readonly protocol = 'responses' as const;

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
        store: false,
        stream: false,
      },
    };
  }

  decode(payload: unknown, requestId?: string): ProviderResult {
    const data = decodeResponsesPayload(payload);
    const output: ProviderResult['output'] = [];
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
