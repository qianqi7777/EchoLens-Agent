import { Server } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';

serveStdio(() => {
  const server = new Server({ name: 'echolens-stdio-fixture', version: '1.0.0' }, {
    capabilities: { tools: {} },
  });
  server.setRequestHandler('tools/list', async () => ({
    tools: [{
      name: 'stdio_echo',
      inputSchema: {
        type: 'object',
        properties: { value: { type: 'string' } },
        required: ['value'],
        additionalProperties: false,
      },
    }],
  }));
  server.setRequestHandler('tools/call', async (request) => ({
    content: [{ type: 'text', text: `stdio:${String(request.params.arguments?.value)}` }],
  }));
  return server;
});
