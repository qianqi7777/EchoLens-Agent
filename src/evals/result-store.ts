import { mkdir, open, readFile, type FileHandle } from 'node:fs/promises';
import { dirname } from 'node:path';
import { redactValueWithReport } from '../providers/redaction.js';
import type { EvalRunRecord } from './types.js';

export class EvalResultStore {
  private handle?: FileHandle;
  private writeQueue: Promise<unknown> = Promise.resolve();

  constructor(readonly filePath: string) {}

  async append(record: EvalRunRecord): Promise<void> {
    // 追加串行化：持久化顺序必须与调用顺序一致，单条失败不阻塞后续追加。
    const operation = this.writeQueue.then(async () => {
      await mkdir(dirname(this.filePath), { recursive: true });
      this.handle ??= await open(this.filePath, 'a+');
      // 结果文件会持久化候选输出，其中可能包含答案与运行环境信息；落盘前整体脱敏，
      // 避免 secrets 或用户数据写入 result.jsonl。
      const sanitized = redactValueWithReport(record).value;
      await this.handle.appendFile(`${JSON.stringify(sanitized)}\n`, 'utf8');
      await this.handle.datasync();
    });
    this.writeQueue = operation.catch(() => undefined);
    return operation;
  }

  async read(): Promise<EvalRunRecord[]> {
    // 先等待所有挂起的追加落盘，保证读到的是最新已持久化的区间。
    await this.writeQueue;
    try {
      const text = await readFile(this.filePath, 'utf8');
      return text.split('\n').filter(Boolean).map((line, index) => {
        try { return JSON.parse(line) as EvalRunRecord; }
        catch { throw new Error(`Eval 结果第 ${index + 1} 行损坏`); }
      });
    } catch (error) {
      if (error instanceof Error && (error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }

  async close(): Promise<void> {
    await this.writeQueue;
    await this.handle?.close();
    this.handle = undefined;
  }
}
