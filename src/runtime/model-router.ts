import type { ChatMessage, ChatModel, ModelRequest, ModelResponse, ModelToolDefinition, ToolCall } from './types.js';

export type ModelRoute = 'direct' | 'local' | 'cloud';
export type PrivacyLevel = 'local-only' | 'metadata' | 'evidence' | 'full-context';

export interface RouteStatus {
  route: ModelRoute;
  available: boolean;
  model: string;
  baseUrl: string;
  privacy: PrivacyLevel;
  reason: string;
}

/**
 * OpenAI-compatible 模型客户端。路由只选一个，不做静默 fallback，避免配置失败
 * 时无意中把本地源码发送到隐私等级更高的远端服务。
 */
export class ModelRouter {
  private constructor(private readonly routes: Map<ModelRoute, RouteStatus>) {}

  static fromEnv(env: NodeJS.ProcessEnv = process.env): ModelRouter {
    const direct = routeStatus('direct', env.AGENT_DIRECT_MODEL ?? 'deepseek-chat', env.AGENT_DIRECT_BASE_URL ?? 'https://api.deepseek.com/v1', env.AGENT_DIRECT_API_KEY, env.AGENT_DIRECT_PRIVACY ?? 'evidence');
    const local = routeStatus('local', env.AGENT_LOCAL_MODEL ?? '', env.AGENT_LOCAL_BASE_URL ?? 'http://127.0.0.1:11434/v1', env.AGENT_LOCAL_API_KEY ?? 'local', 'local-only');
    const cloudBase = env.AGENT_CLOUD_BASE_URL ?? '';
    const cloud = routeStatus('cloud', env.AGENT_CLOUD_MODEL ?? '', cloudBase, env.AGENT_CLOUD_API_KEY, env.AGENT_CLOUD_PRIVACY ?? 'metadata');
    return new ModelRouter(new Map([['direct', direct], ['local', local], ['cloud', cloud]]));
  }

  status(route: ModelRoute = (process.env.AGENT_MODEL_ROUTE as ModelRoute | undefined) ?? 'local'): RouteStatus {
    if (!this.routes.has(route)) throw new Error(`未知模型路由：${route}`);
    return this.routes.get(route)!;
  }

  build(route?: ModelRoute): ChatModel | null {
    const status = this.status(route);
    if (!status.available) return null;
    return new OpenAICompatibleModel(status.model, status.baseUrl, apiKeyFor(route ?? status.route));
  }

  statuses(): RouteStatus[] {
    return [...this.routes.values()];
  }
}

class OpenAICompatibleModel implements ChatModel {
  constructor(readonly model: string, private readonly baseUrl: string, private readonly apiKey: string) {}

  async complete(request: ModelRequest): Promise<ModelResponse> {
    const response = await fetch(`${this.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}) },
      body: JSON.stringify({ model: this.model, messages: request.messages, tools: request.tools?.map(toOpenAiTool), temperature: 0 }),
      signal: request.signal,
    });
    if (!response.ok) throw new Error(`模型请求失败：HTTP ${response.status}`);
    const data = await response.json() as { choices?: Array<{ message?: { content?: string; tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> } }> };
    const message = data.choices?.[0]?.message;
    const toolCalls: ToolCall[] = (message?.tool_calls ?? []).map((call) => ({ id: call.id, name: call.function.name, arguments: parseArguments(call.function.arguments) }));
    return { text: message?.content ?? '', toolCalls };
  }
}

function toOpenAiTool(tool: ModelToolDefinition) {
  return { type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.parameters } };
}

function parseArguments(raw: string): Record<string, unknown> {
  try { const value = JSON.parse(raw); return value && typeof value === 'object' ? value as Record<string, unknown> : {}; } catch { return {}; }
}

function routeStatus(route: ModelRoute, model: string, baseUrl: string, key: string | undefined, privacy: string): RouteStatus {
  const validPrivacy: PrivacyLevel[] = ['local-only', 'metadata', 'evidence', 'full-context'];
  const privacyValue = validPrivacy.includes(privacy as PrivacyLevel) ? privacy as PrivacyLevel : 'metadata';
  return { route, available: Boolean(model && baseUrl && key), model, baseUrl, privacy: privacyValue, reason: model && baseUrl && key ? '' : `路由 ${route} 未完整配置` };
}

function apiKeyFor(route: ModelRoute): string {
  if (route === 'direct') return process.env.AGENT_DIRECT_API_KEY ?? '';
  if (route === 'cloud') return process.env.AGENT_CLOUD_API_KEY ?? '';
  return process.env.AGENT_LOCAL_API_KEY ?? 'local';
}

