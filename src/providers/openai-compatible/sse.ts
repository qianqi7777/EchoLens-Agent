export interface SseRecord {
  event?: string;
  data: string;
  id?: string;
}

const MAX_SSE_EVENT_CHARS = 2 * 1024 * 1024;

export async function* parseSse(
  body: ReadableStream<Uint8Array> | null,
): AsyncGenerator<SseRecord> {
  if (!body) throw new Error('流式响应缺少 body');
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      buffer = buffer.replaceAll('\r\n', '\n');
      if (buffer.length > MAX_SSE_EVENT_CHARS && !buffer.includes('\n\n')) {
        throw new Error('SSE 单事件超过大小上限');
      }
      let boundary = buffer.indexOf('\n\n');
      while (boundary >= 0) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const record = parseBlock(block);
        if (record) yield record;
        boundary = buffer.indexOf('\n\n');
      }
      if (done) break;
    }
    const trailing = buffer.trim();
    if (trailing) {
      const record = parseBlock(trailing);
      if (record) yield record;
    }
  } finally {
    reader.releaseLock();
  }
}

function parseBlock(block: string): SseRecord | undefined {
  const data: string[] = [];
  let event: string | undefined;
  let id: string | undefined;
  for (const line of block.split('\n')) {
    if (!line || line.startsWith(':')) continue;
    const separator = line.indexOf(':');
    const field = separator < 0 ? line : line.slice(0, separator);
    const value = separator < 0 ? '' : line.slice(separator + 1).replace(/^ /u, '');
    if (field === 'data') data.push(value);
    else if (field === 'event') event = value;
    else if (field === 'id') id = value;
  }
  if (data.length === 0) return undefined;
  return { event, id, data: data.join('\n') };
}
