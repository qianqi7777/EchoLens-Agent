import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { ToolRegistry } from '../runtime/tool-registry.js';
import { CodeIntelligenceService, type LanguageServiceBackend } from './code-intelligence-service.js';
import { CodeIntelligenceError, type CodeDiagnostic, type CodeLocation } from './types.js';
import { registerCodeIntelligenceTools } from './tools.js';
import { TreeSitterIndex } from './tree-sitter-index.js';
import { TypeScriptLspClient } from './typescript-lsp-client.js';

test('tree-sitter 提取符号并在 LSP 不可用时完成定义、引用和诊断降级', async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const tree = new TreeSitterIndex();
  const symbols = await tree.outline(root, 'src/source.ts');

  assert.ok(symbols.some((symbol) => symbol.name === 'Greeter' && symbol.kind === 'class'));
  assert.ok(symbols.some((symbol) => symbol.name === 'greet' && symbol.kind === 'function'));
  assert.ok(symbols.some((symbol) => symbol.name === 'label' && symbol.kind === 'field'));
  assert.ok(symbols.every((symbol) => symbol.path === 'src/source.ts' && symbol.evidenceId.startsWith('code:')));

  // 用必然抛 lsp_unavailable 的桩后端确定性覆盖 LSP→tree-sitter 降级路径，避免依赖真实子进程。
  const service = new CodeIntelligenceService(root, { treeSitter: tree, languageService: unavailableLsp() });
  const usage = "export const message = greet('Echo');";
  const column = usage.indexOf('greet') + 1;
  const definition = await service.goToDefinition('src/usage.ts', 2, column);
  const references = await service.findReferences('src/usage.ts', 2, column);
  const diagnostics = await service.getDiagnostics('src/broken.ts');

  assert.equal(definition.engine, 'tree-sitter');
  assert.equal(definition.fallbackReason, 'lsp_unavailable');
  assert.ok(definition.items.some((item) => item.path === 'src/source.ts'));
  assert.equal(references.engine, 'tree-sitter');
  assert.ok(references.items.some((item) => item.path === 'src/usage.ts'));
  assert.equal(diagnostics.engine, 'tree-sitter');
  assert.ok(diagnostics.items.some((item) => item.source === 'tree-sitter-fallback'));

  const registry = new ToolRegistry();
  registerCodeIntelligenceTools(registry, service);
  assert.deepEqual(
    registry.list().map((tool) => tool.name),
    ['find_references', 'find_symbols', 'get_diagnostics', 'go_to_definition', 'outline_file'],
  );
});

test('真实 TypeScript Language Server 返回工作区相对定义、引用和诊断', async (t) => {
  const root = await fixture();
  const client = new TypeScriptLspClient(root, { requestTimeoutMs: 15_000 });
  t.after(async () => {
    await client.close();
    await rm(root, { recursive: true, force: true });
  });
  const usage = "export const message = greet('Echo');";
  const column = usage.indexOf('greet') + 1;

  // LSP 诊断由服务器异步推送，首次 didOpen 后存在推送窗口；client.diagnostics 已内置
  // 5s 等待，此处断言结果来源是 lsp 而非 tree-sitter-fallback。
  const definitions = await client.definition('src/usage.ts', 2, column);
  const references = await client.references('src/usage.ts', 2, column);
  const diagnostics = await client.diagnostics('src/type-error.ts');

  assert.ok(definitions.some((item) => item.path === 'src/source.ts'));
  assert.ok(references.some((item) => item.path === 'src/usage.ts'));
  assert.ok(diagnostics.every((item) => item.path === 'src/type-error.ts' && item.source === 'lsp'));
  // 校验所有返回位置均为工作区相对路径，不泄露临时根目录的绝对路径。
  assert.ok([...definitions, ...references, ...diagnostics].every((item) => !item.path.includes(root)));
});

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'echolens-code-intelligence-'));
  await mkdir(join(root, 'src'));
  await writeFile(join(root, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { strict: true, target: 'ES2022', module: 'CommonJS' },
    include: ['src/**/*.ts'],
  }));
  await writeFile(join(root, 'src', 'source.ts'), [
    'export class Greeter {',
    "  public label = 'hello';",
    '}',
    'export function greet(name: string) {',
    '  return `Hello ${name}`;',
    '}',
    '',
  ].join('\n'));
  await writeFile(join(root, 'src', 'usage.ts'), [
    "import { greet } from './source';",
    "export const message = greet('Echo');",
    '',
  ].join('\n'));
  // broken.ts 故意写成语法错误（tree-sitter 的 ERROR 结点），type-error.ts 故意含类型错误，
  // 分别验证降级诊断与真实 LSP 诊断两条路径。
  await writeFile(join(root, 'src', 'broken.ts'), 'export const broken = ;\n');
  await writeFile(join(root, 'src', 'type-error.ts'), 'export const value: string = 42;\n');
  return root;
}

function unavailableLsp(): LanguageServiceBackend {
  const unavailable = async (): Promise<never> => {
    throw new CodeIntelligenceError('lsp_unavailable', 'test unavailable');
  };
  return {
    definition: unavailable,
    references: unavailable,
    diagnostics: unavailable,
    close: async () => undefined,
  } as LanguageServiceBackend;
}

test('TypeScript LSP URI 规范化兼容工作区别名路径', async (t) => {
  const root = await fixture();
  const aliasParent = await mkdtemp(join(tmpdir(), 'echolens-code-intelligence-alias-'));
  const aliasRoot = join(aliasParent, 'workspace-root-alias');
  await symlink(root, aliasRoot, process.platform === 'win32' ? 'junction' : 'dir');
  const client = new TypeScriptLspClient(aliasRoot);
  t.after(async () => {
    await client.close();
    await rm(aliasParent, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  });

  const locationFromUri = (client as unknown as {
    locationFromUri(uri: string, range: {
      start: { line: number; character: number };
      end: { line: number; character: number };
    }): CodeLocation | undefined;
  }).locationFromUri.bind(client);

  const normalized = locationFromUri(pathToFileURL(join(root, 'src', 'source.ts')).href, {
    start: { line: 0, character: 0 },
    end: { line: 0, character: 5 },
  });

  assert.equal(normalized?.path, 'src/source.ts');
});
