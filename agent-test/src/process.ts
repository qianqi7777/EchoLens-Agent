import { spawn } from 'node:child_process';
import path from 'node:path';
import { redactText } from '../../src/providers/redaction.js';

export interface LabProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  cancelled: boolean;
  truncated: boolean;
}

/** Local test processes are NOT an OS sandbox. Only explicitly authorized callers may start them. */
export function runLabProcess(command: string, args: string[], cwd: string, timeoutMs: number, signal?: AbortSignal): Promise<LabProcessResult> {
  signal?.throwIfAborted();
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, shell: false, windowsHide: true,
      detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = { stdout: [] as Buffer[], stderr: [] as Buffer[] };
    let remaining = 64 * 1024;
    let truncated = false;
    let timedOut = false;
    let cancelled = false;
    let settled = false;
    let fallback: ReturnType<typeof setTimeout> | undefined;
    let stopStarted = false;
    const append = (stream: 'stdout' | 'stderr', bytes: Buffer) => {
      if (remaining <= 0) { truncated = true; return; }
      const accepted = bytes.subarray(0, remaining);
      chunks[stream].push(accepted);
      remaining -= accepted.length;
      if (accepted.length < bytes.length) truncated = true;
    };
    const finish = (code: number, error?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(fallback);
      signal?.removeEventListener('abort', abort);
      resolve({ exitCode: code, stdout: redactText(Buffer.concat(chunks.stdout).toString('utf8')),
        stderr: redactText(error ?? Buffer.concat(chunks.stderr).toString('utf8')), timedOut, cancelled, truncated });
    };
    const stop = () => {
      if (stopStarted || settled) return;
      stopStarted = true;
      if (child.pid) {
        if (process.platform === 'win32') {
          const killer = spawn(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'),
            ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
          killer.on('error', () => child.kill());
          killer.on('close', (code) => { if (code !== 0) child.kill(); });
        } else {
          try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
        }
      }
      fallback = setTimeout(() => {
        child.stdout.destroy(); child.stderr.destroy(); child.unref();
        finish(1, '停止超时，无法确认所有子进程退出，请检查本机进程');
      }, 5000);
    };
    const abort = () => { cancelled = true; stop(); };
    const timer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
    child.stdout.on('data', (data: Buffer) => append('stdout', data));
    child.stderr.on('data', (data: Buffer) => append('stderr', data));
    child.once('error', (error) => finish(1, error.message));
    child.once('close', (code) => finish(code ?? 1));
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
  });
}
