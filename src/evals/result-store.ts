import { mkdir, open, readFile, type FileHandle } from 'node:fs/promises';
import { dirname } from 'node:path';
import { redactValueWithReport } from '../providers/redaction.js';
import type { EvalRunRecord } from './types.js';

export class EvalResultStore {
  private handle?: FileHandle;
  private writeQueue: Promise<unknown> = Promise.resolve();

  constructor(readonly filePath: string) {}

  async append(record: EvalRunRecord): Promise<void> {
    const operation = this.writeQueue.then(async () => {
      await mkdir(dirname(this.filePath), { recursive: true });
      this.handle ??= await open(this.filePath, 'a+');
      const sanitized = redactValueWithReport(record).value;
      await this.handle.appendFile(`${JSON.stringify(sanitized)}\n`, 'utf8');
      await this.handle.datasync();
    });
    this.writeQueue = operation.catch(() => undefined);
    return operation;
  }

  async read(): Promise<EvalRunRecord[]> {
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
