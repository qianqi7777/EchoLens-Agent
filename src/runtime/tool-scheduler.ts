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

/**
 * 工具调度器：并发能力由单轮执行范围内的只读并发与总并发上限约束。
 *
 * 互不依赖的只读工具可并行；副作用工具始终串行，并在执行前排空所有只读批次，保证写操作不与其它工具交错。
 */
export class ToolScheduler {
  private readonly maxReadConcurrency: number;
  private readonly maxTotalConcurrency: number;

  constructor(options: ToolSchedulerOptions = {}) {
    this.maxReadConcurrency = positiveInteger(options.maxReadConcurrency ?? 4, 'maxReadConcurrency');
    this.maxTotalConcurrency = positiveInteger(options.maxTotalConcurrency ?? 4, 'maxTotalConcurrency');
  }

  // 调度算法：按 callIndex 排序后顺序扫描，把互不依赖的只读调用累计成批并行执行；
  // 遇到副作用调用时先排空只读批次再单独串行执行，避免写操作与其它工具交错。
  // supportsParallel=false 表示 Provider 不允许并行工具调用，整轮退化为串行。
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

// 只有明确的只读工具才并行；带 dependsOn 的调用必须按依赖顺序执行。未知工具（registry.get 抛错）
// 按串行处理——宁可降低并发也不把无法确认的工具当作只读并行（fail-closed）。
function isIndependentRead(call: ToolCallItem, registry: ToolRegistry): boolean {
  if (call.dependsOn?.length) return false;
  try {
    const tool = registry.get(call.name);
    return (tool.effect ?? (tool.permission === 'workspace.read' ? 'read' : 'external')) === 'read';
  } catch {
    return false;
  }
}

// 固定 worker 池按索引写入 results，各任务完成顺序不同也不会打乱最终结果顺序。
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
