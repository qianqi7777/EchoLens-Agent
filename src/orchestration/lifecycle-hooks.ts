import type { AgentEvent } from '../session/events.js';

export type LifecycleHookStage = 'session' | 'turn' | 'tool' | 'approval' | 'verify';
export type LifecycleHookTrust = 'builtin' | 'user' | 'repository';

export interface LifecycleHook {
  id: string;
  stages: ReadonlySet<LifecycleHookStage>;
  trust: LifecycleHookTrust;
  handle(event: Readonly<AgentEvent>, signal: AbortSignal): Promise<void>;
}

export interface LifecycleHookResult {
  hookId: string;
  status: 'completed' | 'timeout' | 'failed' | 'skipped';
  reason?: string;
}

export interface LifecycleHookRunnerOptions {
  trustedRepositoryHooks?: ReadonlySet<string>;
  timeoutMs?: number;
}

/** Hooks are bounded observers. They cannot mutate events, call ToolExecutor, or change decisions. */
export class LifecycleHookRunner {
  private readonly hooks = new Map<string, LifecycleHook>();
  private readonly trustedRepositoryHooks: ReadonlySet<string>;
  private readonly timeoutMs: number;

  constructor(options: LifecycleHookRunnerOptions = {}) {
    this.trustedRepositoryHooks = options.trustedRepositoryHooks ?? new Set();
    this.timeoutMs = options.timeoutMs ?? 2_000;
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 10 || this.timeoutMs > 60_000) {
      throw new Error('Hook timeoutMs 无效');
    }
  }

  register(hook: LifecycleHook): void {
    // Hook ID 限定为字母数字开头 + 安全标识符字符集（最长 128），作为稳定标识符并排除特殊字符。
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(hook.id)) throw new Error('Hook ID 无效');
    if (this.hooks.has(hook.id)) throw new Error(`Hook 已注册：${hook.id}`);
    if (!['builtin', 'user', 'repository'].includes(hook.trust)) throw new Error('Hook trust 无效');
    if ([...hook.stages].some((stage) => !['session', 'turn', 'tool', 'approval', 'verify'].includes(stage))) {
      throw new Error('Hook stage 无效');
    }
    this.hooks.set(hook.id, hook);
  }

  async observe(event: AgentEvent): Promise<LifecycleHookResult[]> {
    const stage = eventStage(event);
    if (!stage) return [];
    const results: LifecycleHookResult[] = [];
    for (const hook of this.hooks.values()) {
      if (!hook.stages.has(stage)) continue;
      // 仓库级 Hook 属于不可信输入：只有显式登记在 trustedRepositoryHooks 中的才会执行，其余跳过，避免仓库注入执行逻辑。
      if (hook.trust === 'repository' && !this.trustedRepositoryHooks.has(hook.id)) {
        results.push({ hookId: hook.id, status: 'skipped', reason: 'repository_hook_not_trusted' });
        continue;
      }
      // 传给 Hook 的是 structuredClone 拷贝，Hook 无法改动原事件；且受 timeoutMs 上限约束。
      // 无论 Hook 抛错还是超时都只记录 status，绝不向上抛，避免观察者破坏主流程。
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort('hook_timeout'), this.timeoutMs);
      try {
        await Promise.race([
          hook.handle(structuredClone(event), controller.signal),
          new Promise<never>((_, reject) => controller.signal.addEventListener('abort', () => reject(new Error('HOOK_TIMEOUT')), { once: true })),
        ]);
        results.push({ hookId: hook.id, status: 'completed' });
      } catch (error) {
        results.push({
          hookId: hook.id,
          status: controller.signal.aborted ? 'timeout' : 'failed',
          reason: error instanceof Error ? error.name : 'hook_failed',
        });
      } finally {
        clearTimeout(timer);
      }
    }
    return results;
  }
}

function eventStage(event: AgentEvent): LifecycleHookStage | undefined {
  const type = event.payload.type;
  if (type.startsWith('session.')) return 'session';
  if (type.startsWith('turn.') || type.startsWith('run.') || type.startsWith('model.')) return 'turn';
  if (type.startsWith('tool.')) return 'tool';
  if (type.startsWith('approval.')) return 'approval';
  if (type.startsWith('verification.')) return 'verify';
  return undefined;
}
