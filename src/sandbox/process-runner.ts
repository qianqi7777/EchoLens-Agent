import { spawn } from 'node:child_process';

export interface ProcessRunRequest {
  executable: string;
  args: readonly string[];
  cwd?: string;
  timeoutMs: number;
  maxOutputBytes: number;
  signal?: AbortSignal;
}
export interface ProcessRunResult {
  exitCode?: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  cancelled: boolean;
  outputTruncated: boolean;
  spawnError?: string;
}

export interface ProcessRunner {
  run(request: ProcessRunRequest): Promise<ProcessRunResult>;
}

export class NodeProcessRunner implements ProcessRunner {
  async run(request: ProcessRunRequest): Promise<ProcessRunResult> {
    const started = Date.now();
    return new Promise((resolve) => {
      const child = spawn(request.executable, [...request.args], {
        cwd: request.cwd,
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const output = boundedOutput(request.maxOutputBytes);
      let timedOut = false;
      let cancelled = false;
      let spawnError: string | undefined;
      let settled = false;
      const finish = (exitCode?: number) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        request.signal?.removeEventListener('abort', abort);
        resolve({
          exitCode,
          stdout: output.stdout(),
          stderr: output.stderr(),
          durationMs: Math.max(0, Date.now() - started),
          timedOut,
          cancelled,
          outputTruncated: output.truncated(),
          spawnError,
        });
      };
      child.stdout.on('data', (chunk) => output.append('stdout', Buffer.from(chunk)));
      child.stderr.on('data', (chunk) => output.append('stderr', Buffer.from(chunk)));
      child.once('error', (error) => {
        spawnError = error.message;
        finish();
      });
      child.once('close', (code) => finish(code ?? undefined));
      const abort = () => {
        cancelled = true;
        child.kill();
      };
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill();
      }, request.timeoutMs);
      if (request.signal?.aborted) abort();
      else request.signal?.addEventListener('abort', abort, { once: true });
    });
  }
}

function boundedOutput(limit: number): {
  append(stream: 'stdout' | 'stderr', bytes: Buffer): void;
  stdout(): string;
  stderr(): string;
  truncated(): boolean;
} {
  const chunks = { stdout: [] as Buffer[], stderr: [] as Buffer[] };
  let remaining = limit;
  let wasTruncated = false;
  return {
    append(stream, bytes) {
      if (remaining <= 0) { wasTruncated = true; return; }
      const accepted = bytes.subarray(0, remaining);
      chunks[stream].push(accepted);
      remaining -= accepted.byteLength;
      if (accepted.byteLength < bytes.byteLength) wasTruncated = true;
    },
    stdout: () => Buffer.concat(chunks.stdout).toString('utf8'),
    stderr: () => Buffer.concat(chunks.stderr).toString('utf8'),
    truncated: () => wasTruncated,
  };
}
