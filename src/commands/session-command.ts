import type { SessionDescriptor } from '../session/jsonl-event-store.js';

export interface SessionCommands {
  currentSessionId: string;
  list(): Promise<readonly SessionDescriptor[]>;
  delete(session: SessionDescriptor): Promise<void>;
  confirm(message: string): Promise<boolean>;
}

export async function executeSessionCommand(input: string, service: SessionCommands): Promise<string[]> {
  const parts = input.trim().split(/\s+/u);
  if (parts[0] === '/sessions' && parts.length === 1) {
    const sessions = await service.list();
    return sessions.length ? sessions.map((item) =>
      `${item.sessionId}${item.sessionId === service.currentSessionId ? ' [当前]' : ''} | ${item.modifiedAt} | ${item.bytes} bytes`,
    ) : ['暂无 Session。'];
  }
  if (parts[0] !== '/session' || parts[1] !== 'delete' || parts.length !== 3) {
    return ['用法：/session delete <session-id>'];
  }
  const id = parts[2]!;
  if (id === service.currentSessionId) throw new Error('不能删除当前会话，请先退出或切换工作目录');
  const session = (await service.list()).find((item) => item.sessionId === id);
  if (!session) throw new Error('未找到该历史会话');
  if (!await service.confirm(`永久删除会话 ${id}？\n${session.bytes} bytes\n仅删除日志，代码、检查点和产物保留。`)) {
    return ['已取消删除，会话保持不变。'];
  }
  await service.delete(session);
  return [`已删除历史会话：${id}`];
}
