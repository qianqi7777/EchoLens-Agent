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
      // shell:false 让 executable+args 作为独立数组直接启动、不经 Shell，参数中的 Shell 元字符不会被解释，
      // 这是“防命令注入”的边界所在；windowsHide 在 Windows 下隐藏子进程控制台窗口。
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
      // spawn 失败（如可执行文件不存在）走 error 事件且没有 exitCode，与正常退出（close 带 code）区分，
      // 调用方据此判断是“进程没起来”而非“进程以某状态退出”。
      child.once('error', (error) => {
        spawnError = error.message;
        finish();
      });
      child.once('close', (code) => finish(code ?? undefined));
      // 超时与外部取消都走 child.kill()（默认 SIGTERM）；finish 用 settled 保证 close/error/abort 只结算一次，
      // 避免竞态下重复 resolve。kill 只发出信号，进程若忽略 SIGTERM 则不会触发 close、promise 不结算，
      // runner 不承诺强制终止，上层调用方（如 Docker 容器）需靠 --rm 与资源限制兜底。
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

// 按总量上限截断 stdout/stderr 缓冲，避免子进程持续输出导致内存失控；同时记录截断标记供调用方感知。
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
