import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { InMemoryTransport } from '@modelcontextprotocol/client';
import { Server } from '@modelcontextprotocol/server';
import { McpClientManager } from '../../../../src/mcp/client-manager.js';
import type { McpServerConfig } from '../../../../src/mcp/types.js';

test('MCP 配额串行计数在并发调用下不超发', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'echolens-mcp-quota-perf-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = new Server({ name: 'quota-perf', version: '1' }, { capabilities: { tools: {} } });
  server.setRequestHandler('tools/list', async () => ({ tools: [{ name: 'echo', inputSchema: { type: 'object' } }] }));
  server.setRequestHandler('tools/call', async () => ({ content: [{ type: 'text', text: 'ok' }] }));
  await server.connect(serverTransport); t.after(() => server.close());
  const manager = new McpClientManager(root, { transportFactory: () => clientTransport });
  t.after(() => manager.close());
  const config: McpServerConfig = { id: 'perf', enabled: true, trust: 'untrusted', quota: { maxCallsPerSession: 50 }, transport: { type: 'stdio', command: 'unused' } };
  await manager.connect(config);
  const results = await Promise.allSettled(Array.from({ length: 100 }, () => manager.callTool('perf', 'echo', {})));
  assert.equal(results.filter((item) => item.status === 'fulfilled').length, 50);
  assert.equal(results.filter((item) => item.status === 'rejected').length, 50);
});
