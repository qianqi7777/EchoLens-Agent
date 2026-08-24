export interface RequestSignal {
  signal: AbortSignal;
  timedOut(): boolean;
  dispose(): void;
}

export function createRequestSignal(
  externalSignal: AbortSignal | undefined,
  timeoutMs: number,
  timeoutMessage: string,
): RequestSignal {
  const controller = new AbortController();
  let timedOut = false;
  const abortFromExternal = () => controller.abort(externalSignal?.reason);
  const timer = timeoutMs > 0
    ? setTimeout(() => {
        timedOut = true;
        controller.abort(new DOMException(timeoutMessage, 'TimeoutError'));
      }, timeoutMs)
    : undefined;

  if (externalSignal?.aborted) abortFromExternal();
  else externalSignal?.addEventListener('abort', abortFromExternal, { once: true });

  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    dispose: () => {
      if (timer) clearTimeout(timer);
      externalSignal?.removeEventListener('abort', abortFromExternal);
    },
  };
}
