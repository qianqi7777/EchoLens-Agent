const REDACTED = '[REDACTED]';
const sensitiveKey = /(?:authorization|proxy-authorization|cookie|set-cookie|api[-_]?key|access[-_]?token|refresh[-_]?token|password|passwd|secret|credential)/i;
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

export function redactText(value: string): string {
  return redactTextWithReport(value).value;
}

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
    return redactText(value);
  }
}

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
