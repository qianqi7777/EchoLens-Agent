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
  // 合并外部取消与本请求超时到独立的 controller：任一路径都会中止 fetch，
  // 但只有超时路径置位 timedOut，调用方据此区分“用户取消”与“请求超时”并选择错误类别。
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
    // dispose 由调用方在 finally 中保证执行：清除定时器并移除监听，
    // 避免请求结束后定时器仍触发，或监听继续把外部取消转发到已完成的请求。
    dispose: () => {
      if (timer) clearTimeout(timer);
      externalSignal?.removeEventListener('abort', abortFromExternal);
    },
  };
}
