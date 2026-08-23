import type { Permission, ToolContext, ToolResult } from './types.js';
import { ToolRegistry } from './tool-registry.js';

export interface ToolExecutorOptions {
  maxCalls?: number;
  timeoutMs?: number;
  maxOutputChars?: number;
}

/**
 * 所有内置工具和 MCP Adapter 的唯一执行入口。
 *
 * 这里是以后加入审批、审计、成本统计和沙箱的扩展点。模型永远不能直接
 * 调用 fs 或 child_process，只能提交一个经过校验的工具调用。
 */
export class ToolExecutor {
  private readonly maxCalls: number;
  private readonly timeoutMs: number;
  private readonly maxOutputChars: number;
  private callCount = 0;

  constructor(
    private readonly registry: ToolRegistry,
    options: ToolExecutorOptions = {},
  ) {
    this.maxCalls = options.maxCalls ?? 24;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.maxOutputChars = options.maxOutputChars ?? 12_000;
  }

  async invoke(
    name: string,
    args: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolResult> {
    const tool = this.registry.get(name);
    if (this.callCount >= this.maxCalls) {
      return this.result('error', '已达到本回合工具调用预算', 'budget_exhausted');
    }
    if (!context.allowedPermissions.has(tool.permission)) {
      return this.result('denied', `没有工具权限：${tool.permission}`, 'permission_denied');
    }

    const validationError = validateArgs(tool.inputSchema.required ?? [], args);
    if (validationError) return this.result('error', validationError, 'invalid_arguments');

    this.callCount += 1;
    const controller = new AbortController();
    const abort = () => controller.abort();
    context.signal.addEventListener('abort', abort, { once: true });

    try {
      const result = await withTimeout(
        tool.execute(args, { ...context, signal: controller.signal }),
        this.timeoutMs,
        controller,
      );
      return {
        ...result,
        content: truncate(result.content, this.maxOutputChars),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const timeout = message === 'TOOL_TIMEOUT';
      return this.result(timeout ? 'timeout' : 'error', message, timeout ? 'timeout' : 'tool_failed');
    } finally {
      context.signal.removeEventListener('abort', abort);
    }
  }

  resetBudget(): void {
    this.callCount = 0;
  }

  private result(status: ToolResult['status'], content: string, summary: string): ToolResult {
    return { status, content, summary, evidenceIds: [] };
  }
}

function validateArgs(required: string[], args: Record<string, unknown>): string | null {
  const missing = required.filter((key) => args[key] === undefined || args[key] === null);
  return missing.length ? `缺少工具参数：${missing.join(', ')}` : null;
}

function truncate(value: string, limit: number): string {
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}\n[output truncated: ${value.length - limit} chars]`;
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  controller: AbortController,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error('TOOL_TIMEOUT'));
    }, timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

