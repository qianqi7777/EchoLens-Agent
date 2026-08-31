export interface SseRecord {
  event?: string;
  data: string;
  id?: string;
}

// 单个事件的上限。SSE 消息本应短小，超出说明连接被劫持或协议损坏，
// 用上限防止恶意端点通过不结束的空行把内存无限撑大。
const MAX_SSE_EVENT_CHARS = 2 * 1024 * 1024;

/**
 * 把 HTTP 响应体按 SSE 协议逐事件解析。
 *
 * 网络分片可以在任意字节处切断，因此跨分片的 `\r\n`、多字节字符与空行边界都必须
 * 在累积后的完整 buffer 上处理（见函数内注释），不能在每次 read 的分片上单独判断。
 * @yields 每个完整事件（注释行与无 data 的块会被跳过）。
 */
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
      // done=false 时用流式解码，避免多字节 UTF-8 字符被网络分片切断产生乱码。
      buffer += decoder.decode(value, { stream: !done });
      // 统一 CRLF 为 LF：SSE 允许 \r\n 或 \n，且 \r\n 可能跨网络分片，必须先在累积后的
      // 完整 buffer 上归一，否则 \n\n 与 \r\n\r\n 两种空行边界无法统一识别。
      buffer = buffer.replaceAll('\r\n', '\n');
      // 事件以空行（\n\n）分隔；单事件超上限且仍未出现空行，判定为损坏并抛出，避免无限累积。
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
  // SSE 规范：data 行可多行，按 \n 连接；以 ':' 开头的行为注释，应忽略。
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
