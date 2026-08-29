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
      if (hook.trust === 'repository' && !this.trustedRepositoryHooks.has(hook.id)) {
        results.push({ hookId: hook.id, status: 'skipped', reason: 'repository_hook_not_trusted' });
        continue;
      }
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
