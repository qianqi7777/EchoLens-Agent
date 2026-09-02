import { Server } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';

// 测试专用 MCP stdio 服务端：只暴露一个确定性回显工具，用于驱动被测 MCP 客户端
// 的 stdio 传输与参数序列化。刻意不声明 prompts / resources / sampling 等能力，
// 便于测试断言客户端只会看到本文件声明的能力集。
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
  // 回显统一加 stdio: 前缀，使输出来源可区分；String() 强制任意参数类型
  // 转成文本，避免客户端序列化差异影响断言。
  server.setRequestHandler('tools/call', async (request) => ({
    content: [{ type: 'text', text: `stdio:${String(request.params.arguments?.value)}` }],
  }));
  return server;
});
