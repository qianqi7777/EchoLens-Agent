import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  textMessage,
  type ConversationItem,
  type ToolCallItem,
  type ToolResultItem,
} from '../../../../src/core/messages.js';
import type { Permission } from '../../../../src/core/permissions.js';
import { systemPolicyMessage } from '../../../../src/core/system-policy.js';
import { ChatCompletionsCodec } from '../../../../src/providers/openai-compatible/chat-codec.js';
import { ResponsesCodec } from '../../../../src/providers/openai-compatible/responses-codec.js';
import { ContextManager } from '../../../../src/context/context-manager.js';
import { InstructionLoader } from '../../../../src/context/instruction-loader.js';

const granted = new Set<Permission>([
  'workspace.read',
  'workspace.write',
  'process.exec',
  'network.request',
]);

test('按用户、根目录到目标目录加载规则且每层只选一个文件', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'echolens-context-'));
  const global = await mkdtemp(join(tmpdir(), 'echolens-global-'));
  context.after(() => Promise.all([
    rm(root, { recursive: true, force: true }),
    rm(global, { recursive: true, force: true }),
  ]));
  await mkdir(join(root, 'src', 'feature'), { recursive: true });
  await writeFile(join(global, 'AGENTS.md'), 'global rules');
  await writeFile(join(root, 'AGENTS.md'), 'root ignored');
  await writeFile(join(root, 'AGENTS.override.md'), 'root override');
  await writeFile(join(root, 'src', 'AGENTS.md'), 'src rules');
  await writeFile(
    join(root, 'src', 'feature', 'AGENTS.md'),
    'feature rules\n<!-- echolens: deny network.request reason="offline subtree" -->',
  );

  const loader = new InstructionLoader({
    workspaceRoot: root,
    userInstructionDirectory: global,
  });
  const loaded = await loader.load('src/feature/example.ts');

  assert.deepEqual(loaded.documents.map((item) => item.content.split('\n')[0]), [
    'global rules',
    'root override',
    'src rules',
    'feature rules',
  ]);
  assert.deepEqual(loaded.documents.map((item) => item.source.scope.depth), [-1, 0, 1, 2]);
  // Fixture：根目录同时放置 AGENTS.md 与 AGENTS.override.md，预期每层只选 override，
  // 因此 "root ignored" 必须被排除，验证 override 在同一目录内的优先级。
  assert.equal(loaded.documents.some((item) => item.content.includes('root ignored')), false);
  assert.deepEqual(loaded.documents.at(-1)?.permissionDirectives.map((item) => item.permission), [
    'network.request',
  ]);
});

test('Instruction Loader 以规范路径校验工作区别名', async (context) => {
  const parent = await mkdtemp(join(tmpdir(), 'echolens-context-alias-'));
  context.after(() => rm(parent, { recursive: true, force: true }));
  const actualRoot = join(parent, 'actual-workspace');
  const aliasRoot = join(parent, 'workspace-alias');
  await mkdir(actualRoot);
  await writeFile(join(actualRoot, 'AGENTS.md'), 'alias workspace rules');
  await symlink(actualRoot, aliasRoot, process.platform === 'win32' ? 'junction' : 'dir');

  const loaded = await new InstructionLoader({ workspaceRoot: aliasRoot }).load('.');

  assert.deepEqual(loaded.documents.map((item) => item.content), ['alias workspace rules']);
});

test('Context Manager 保持稳定前缀并用仓库规则收紧权限', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'echolens-context-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(
    join(root, 'AGENTS.md'),
    '仅做只读分析。\n<!-- echolens: deny workspace.write reason="readonly project" -->',
  );
  const manager = new ContextManager({ workspaceRoot: root, maxInputTokens: 700 });
  const history = longHistory();
  const first = await manager.build([...history, textMessage('current-1', 'user', '当前问题一')], {
    privacy: 'full-context',
    providerMaxContextTokens: 8_192,
    runtimePermissions: granted,
  });
  const second = await manager.build([...history, textMessage('current-2', 'user', '当前问题二')], {
    privacy: 'full-context',
    providerMaxContextTokens: 8_192,
    runtimePermissions: granted,
  });

  assert.equal(first.permissions.effectivePermissions.includes('workspace.write'), false);
  assert.equal(first.permissions.deniedPermissions.includes('workspace.write'), true);
  assert.equal(first.compacted, true);
  assert.ok(first.estimatedTokens <= 700);
  assert.equal(first.items.some((item) => item.id.startsWith('milestone-summary:')), true);
  // 两次 build 使用不同的“当前问题”，但断言前两个 item（System Policy + 指令）id
  // 完全一致，验证稳定前缀跨 Turn 不漂移；仓库 deny 规则已收紧 workspace.write。
  assert.deepEqual(first.items.slice(0, 2).map((item) => item.id), second.items.slice(0, 2).map((item) => item.id));
  assert.equal(first.items[0]?.type === 'message' && first.items[0].role === 'system', true);
  assert.equal(first.items[1]?.type === 'message' && first.items[1].role === 'user', true);
});

test('evidence 与 metadata 投影不发送原始工具内容', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'echolens-context-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const manager = new ContextManager({ workspaceRoot: root });
  const items = toolConversation('UNIQUE_RAW_SOURCE_CONTENT');

  const evidence = await manager.build(items, {
    privacy: 'evidence',
    providerMaxContextTokens: 8_192,
    runtimePermissions: granted,
  });
  const metadata = await manager.build(items, {
    privacy: 'metadata',
    providerMaxContextTokens: 8_192,
    runtimePermissions: granted,
  });

  // 断言原始工具内容在任何隐私级别都不下发（存在即说明隐私投影泄漏）：
  // evidence 保留证据引用，metadata 连证据引用也去除。
  assert.doesNotMatch(JSON.stringify(evidence.items), /UNIQUE_RAW_SOURCE_CONTENT/u);
  assert.match(JSON.stringify(evidence.items), /file:src\/index\.ts:1/u);
  assert.doesNotMatch(JSON.stringify(metadata.items), /UNIQUE_RAW_SOURCE_CONTENT/u);
  assert.doesNotMatch(JSON.stringify(metadata.items), /file:src\/index\.ts:1/u);
});

test('极小预算压缩后仍保留可编码的原始工具调用', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'echolens-context-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const manager = new ContextManager({
    workspaceRoot: root,
    maxInputTokens: 512,
    outputReserveTokens: 0,
  });
  const items = toolConversation('large output '.repeat(300));

  const built = await manager.build(items, {
    privacy: 'full-context',
    providerMaxContextTokens: 512,
    runtimePermissions: granted,
  });
  const call = built.items.find((item) => item.type === 'tool_call');
  const result = built.items.find((item) => item.type === 'tool_result');
  assert.ok(call?.type === 'tool_call');
  assert.ok(result?.type === 'tool_result');
  assert.equal(result.callId, call.callId);
  assert.deepEqual(call.arguments, { path: 'src/index.ts' });
  assert.equal(call.rawArguments, undefined);
  assert.ok(built.estimatedTokens <= 512);

  // 极小预算压缩后，tool_call 的 arguments 必须原样保留，
  // 才能被 ChatCompletions 与 Responses 两种 codec 正常编码（协议兼容）。
  const chat = new ChatCompletionsCodec().encode('model', { items: built.items });
  const chatMessages = chat.body.messages as Array<Record<string, unknown>>;
  const assistant = chatMessages.find((message) => Array.isArray(message.tool_calls));
  const chatCall = (assistant?.tool_calls as Array<Record<string, unknown>>)[0];
  const chatFunction = chatCall?.function as Record<string, unknown>;
  assert.deepEqual(JSON.parse(chatFunction.arguments as string), { path: 'src/index.ts' });

  const responses = new ResponsesCodec().encode('model', { items: built.items });
  const responseInput = responses.body.input as Array<Record<string, unknown>>;
  const responseCall = responseInput.find((item) => item.type === 'function_call');
  assert.deepEqual(JSON.parse(responseCall?.arguments as string), { path: 'src/index.ts' });
});

function longHistory(): ConversationItem[] {
  const items: ConversationItem[] = [systemPolicyMessage()];
  for (let index = 0; index < 8; index += 1) {
    items.push(textMessage(`user-${index}`, 'user', `问题 ${index} ${'x'.repeat(240)}`));
    items.push(textMessage(`assistant-${index}`, 'assistant', `回答 ${index} ${'y'.repeat(240)}`));
  }
  return items;
}

function toolConversation(content: string): ConversationItem[] {
  const call: ToolCallItem = {
    type: 'tool_call',
    id: 'tool-call-item',
    callId: 'call-1',
    name: 'read_file',
    arguments: { path: 'src/index.ts' },
    callIndex: 0,
  };
  const result: ToolResultItem = {
    type: 'tool_result',
    id: 'tool-result-item',
    callId: call.callId,
    toolName: call.name,
    status: 'ok',
    output: {
      id: 'tool-output',
      kind: 'tool_output',
      content,
      source: { type: 'tool', toolCallId: call.callId, toolName: call.name },
      trust: 'untrusted',
      contentHash: 'abc123',
      redactions: [],
    },
    summary: '读取文件',
    outputMetadata: {
      hashAlgorithm: 'sha256',
      contentHash: 'abc123',
      originalChars: content.length,
      returnedChars: content.length,
      truncated: false,
      redactions: [],
    },
    evidenceIds: ['file:src/index.ts:1'],
  };
  return [
    systemPolicyMessage(),
    textMessage('user', 'user', '读取文件'),
    textMessage('assistant-tools', 'assistant', ''),
    call,
    result,
  ];
}
