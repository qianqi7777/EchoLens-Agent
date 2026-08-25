import type { ToolCallItem } from '../core/messages.js';
import type { ToolRegistry } from './tool-registry.js';

export interface ToolSchedulerOptions {
  maxReadConcurrency?: number;
  maxTotalConcurrency?: number;
}

export interface ScheduledToolResult<T> {
  call: ToolCallItem;
  value: T;
}

export class ToolScheduler {
  private readonly maxReadConcurrency: number;
  private readonly maxTotalConcurrency: number;

  constructor(options: ToolSchedulerOptions = {}) {
    this.maxReadConcurrency = positiveInteger(options.maxReadConcurrency ?? 4, 'maxReadConcurrency');
    this.maxTotalConcurrency = positiveInteger(options.maxTotalConcurrency ?? 4, 'maxTotalConcurrency');
  }

  async execute<T>(
    calls: readonly ToolCallItem[],
    registry: ToolRegistry,
    handler: (call: ToolCallItem) => Promise<T>,
    supportsParallel = true,
  ): Promise<Array<ScheduledToolResult<T>>> {
    const ordered = [...calls].sort((left, right) => left.callIndex - right.callIndex);
    const results: Array<ScheduledToolResult<T>> = [];
    let readWave: ToolCallItem[] = [];
    const flushReads = async () => {
      if (readWave.length === 0) return;
      const limit = supportsParallel
        ? Math.min(this.maxReadConcurrency, this.maxTotalConcurrency)
        : 1;
      results.push(...await mapLimit(readWave, limit, async (call) => ({ call, value: await handler(call) })));
      readWave = [];
    };

    for (const call of ordered) {
      if (isIndependentRead(call, registry)) {
        readWave.push(call);
        continue;
      }
      await flushReads();
      results.push({ call, value: await handler(call) });
    }
    await flushReads();
    return results.sort((left, right) => left.call.callIndex - right.call.callIndex);
  }
}

function isIndependentRead(call: ToolCallItem, registry: ToolRegistry): boolean {
  if (call.dependsOn?.length) return false;
  try {
    const tool = registry.get(call.name);
    return (tool.effect ?? (tool.permission === 'workspace.read' ? 'read' : 'external')) === 'read';
  } catch {
    return false;
  }
}

async function mapLimit<T, R>(
  items: readonly T[],
  concurrency: number,
  mapper: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      results[index] = await mapper(items[index]!);
    }
  });
  await Promise.all(workers);
  return results;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} 必须是正整数`);
  return value;
}
