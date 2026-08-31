// 脱敏采用“敏感键/头整值替换 + 文本正则兜底”的尽力策略：先按键名判断，再对剩余字符串
// 套用常见秘密格式正则。策略无法穷尽所有秘密形态，因此 Provider 原始响应一律不允许
// 未经脱敏直接进入日志或错误文本。
const REDACTED = '[REDACTED]';
const sensitiveKey = /(?:authorization|proxy-authorization|cookie|set-cookie|api[-_]?key|access[-_]?token|refresh[-_]?token|^token$|password|passwd|secret|credential)/i;
const sensitiveQueryKey = /(?:key|token|secret|password|signature|credential|authorization)/i;

export interface RedactionResult<T> {
  value: T;
  redactions: string[];
}

const textRedactionRules: Array<{ kind: string; pattern: RegExp; replacement: string }> = [
  {
    kind: 'private_key',
    pattern: /-----BEGIN(?: [A-Z0-9]+)? PRIVATE KEY-----[\s\S]*?-----END(?: [A-Z0-9]+)? PRIVATE KEY-----/g,
    replacement: REDACTED,
  },
  {
    kind: 'authorization_header',
    pattern: /((?:authorization|proxy-authorization)\s*:\s*)(?:Bearer|Basic)\s+[^\r\n]+/gi,
    replacement: `$1${REDACTED}`,
  },
  {
    kind: 'bearer_token',
    pattern: /\bBearer\s+[^\s,;]+/gi,
    replacement: `Bearer ${REDACTED}`,
  },
  {
    kind: 'api_key',
    pattern: /\bsk-[A-Za-z0-9_-]{8,}\b/g,
    replacement: REDACTED,
  },
  {
    kind: 'github_token',
    pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
    replacement: REDACTED,
  },
  {
    kind: 'aws_access_key',
    pattern: /\bAKIA[0-9A-Z]{16}\b/g,
    replacement: REDACTED,
  },
  {
    kind: 'secret_assignment',
    pattern: /((?:api[-_]?key|access[-_]?token|refresh[-_]?token|password|secret)\s*[=:]\s*)[^\s,;&]+/gi,
    replacement: `$1${REDACTED}`,
  },
];

/** 文本脱敏入口：只返回脱敏结果，不需要报告命中项时使用。 */
export function redactText(value: string): string {
  return redactTextWithReport(value).value;
}

/**
 * 文本脱敏并报告命中的规则。
 * @returns 脱敏后的文本与命中的规则 kind（去重排序），便于审计“是否真的做了脱敏”。
 */
export function redactTextWithReport(value: string): RedactionResult<string> {
  let output = value;
  const redactions = new Set<string>();
  for (const rule of textRedactionRules) {
    const next = output.replace(rule.pattern, rule.replacement);
    if (next !== output) redactions.add(rule.kind);
    output = next;
  }
  return { value: output, redactions: [...redactions].sort() };
}

// Authorization / Set-Cookie 等头的值整体就是凭据，命中敏感键名时整段替换，
// 而不是剥离令牌后留下兜底正则无法覆盖的上下文文本。
export function redactHeaders(headers: HeadersInit): Record<string, string> {
  const output: Record<string, string> = {};
  new Headers(headers).forEach((value, key) => {
    output[key] = sensitiveKey.test(key) ? REDACTED : redactText(value);
  });
  return output;
}

export function redactUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.username) url.username = REDACTED;
    if (url.password) url.password = REDACTED;
    for (const key of url.searchParams.keys()) {
      if (sensitiveQueryKey.test(key)) url.searchParams.set(key, REDACTED);
    }
    return url.toString();
  } catch {
    // 无法解析为 URL 时退化为文本脱敏，至少覆盖常见秘密格式（失败策略：不影响日志输出）。
    return redactText(value);
  }
}

/**
 * 递归脱敏任意 JSON 兼容值（含 Error 对象）。
 *
 * 必须永不抛错：日志与错误信息生成路径上调用它，任何异常都会让原始错误无法上报，
 * 因此循环引用、不可序列化节点一律替换为占位符而不是抛出。
 */
export function redactValue(value: unknown, seen = new WeakSet<object>()): unknown {
  return redactValueWithReport(value, seen).value;
}

export function redactValueWithReport(
  value: unknown,
  seen = new WeakSet<object>(),
  redactions = new Set<string>(),
): RedactionResult<unknown> {
  if (typeof value === 'string') {
    const result = redactTextWithReport(value);
    result.redactions.forEach((kind) => redactions.add(kind));
    return { value: result.value, redactions: [...redactions].sort() };
  }
  if (value === null || typeof value !== 'object') {
    return { value, redactions: [...redactions].sort() };
  }
  // 循环引用替换为占位符：脱敏函数必须永不抛错，宁可丢弃无法还原的节点也不能中断日志生成。
  if (seen.has(value)) return { value: '[Circular]', redactions: [...redactions].sort() };
  seen.add(value);

  if (Array.isArray(value)) {
    const output = value.map((entry) => redactValueWithReport(entry, seen, redactions).value);
    return { value: output, redactions: [...redactions].sort() };
  }
  if (value instanceof Error) {
    return {
      value: {
        name: value.name,
        message: redactValueWithReport(value.message, seen, redactions).value,
        cause: redactValueWithReport(value.cause, seen, redactions).value,
      },
      redactions: [...redactions].sort(),
    };
  }

  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (sensitiveKey.test(key)) {
      output[key] = REDACTED;
      redactions.add('sensitive_field');
    } else {
      output[key] = redactValueWithReport(entry, seen, redactions).value;
    }
  }
  return { value: output, redactions: [...redactions].sort() };
}

// Provider 错误体视为不可信输入：每个字段先脱敏再截断到 500 字符，
// 防止超长或含秘密的错误描述随日志落盘。
export function safeProviderDetails(payload: unknown): { code?: string; type?: string; message?: string } {
  if (!isRecord(payload)) return {};
  const error = isRecord(payload.error) ? payload.error : payload;
  return {
    code: safeString(error.code),
    type: safeString(error.type),
    message: safeString(error.message),
  };
}

function safeString(value: unknown): string | undefined {
  return typeof value === 'string' ? redactText(value).slice(0, 500) : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
