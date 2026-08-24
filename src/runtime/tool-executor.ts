import type { Permission, ToolContext, ToolResult } from './types.js';
import { ToolRegistry } from './tool-registry.js';
import { toolFailure } from './tool-result.js';
import { hardenToolResult } from './tool-output.js';

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
    return hardenToolResult(await this.invokeRaw(name, args, context), this.maxOutputChars);
  }

  private async invokeRaw(
    name: string,
    args: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolResult> {
    let tool;
    try {
      tool = this.registry.get(name);
    } catch {
      return toolFailure('invalid', 'unknown_tool', `未知工具：${name}`, {
        data: { toolName: name },
      });
    }
    if (this.callCount >= this.maxCalls) {
      return toolFailure('failed', 'budget_exhausted', '已达到本回合工具调用预算', {
        data: { maxCalls: this.maxCalls },
      });
    }
    if (!context.allowedPermissions.has(tool.permission)) {
      return toolFailure('denied', 'permission_denied', `没有工具权限：${tool.permission}`, {
        data: { permission: tool.permission },
      });
    }

    const validation = this.registry.validate(name, args);
    if (!validation.valid) {
      return toolFailure('invalid', 'invalid_arguments', '工具参数不符合 Schema', {
        data: { issues: validation.issues },
      });
    }
    if (context.signal.aborted) return toolFailure('cancelled', 'cancelled', '工具调用已取消');

    this.callCount += 1;
    const controller = new AbortController();
    const controlState = { timedOut: false, cancelled: false };

    try {
      const result = await withExecutionControls(
        Promise.resolve().then(() => tool.execute(args, { ...context, signal: controller.signal })),
        this.timeoutMs,
        controller,
        context.signal,
        controlState,
      );
      return result;
    } catch {
      if (controlState.timedOut) {
        return toolFailure('timeout', 'timeout', '工具执行超时', {
          retryable: true,
          data: { timeoutMs: this.timeoutMs },
        });
      }
      if (controlState.cancelled || context.signal.aborted) {
        return toolFailure('cancelled', 'cancelled', '工具调用已取消');
      }
      return toolFailure('failed', 'tool_failed', '工具执行失败');
    }
  }

  resetBudget(): void {
    this.callCount = 0;
  }

}

async function withExecutionControls<T>(
  promise: Promise<T>,
  timeoutMs: number,
  controller: AbortController,
  externalSignal: AbortSignal,
  state: { timedOut: boolean; cancelled: boolean },
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      state.timedOut = true;
      controller.abort();
      reject(new Error('TOOL_TIMEOUT'));
    }, timeoutMs);
  });
  const cancellation = new Promise<never>((_, reject) => {
    abort = () => {
      state.cancelled = true;
      controller.abort(externalSignal.reason);
      reject(new Error('TOOL_CANCELLED'));
    };
    if (externalSignal.aborted) abort();
    else externalSignal.addEventListener('abort', abort, { once: true });
  });
  try {
    return await Promise.race([promise, timeout, cancellation]);
  } finally {
    if (timer) clearTimeout(timer);
    if (abort) externalSignal.removeEventListener('abort', abort);
  }
}
