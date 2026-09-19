import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ECHOLENS_FEATURES } from '../../../../src/navigation/feature-index.js';
import { NavigationResolver, parseNavigationMode } from '../../../../src/navigation/navigation-resolver.js';
import type { FeatureIndexEntry } from '../../../../src/navigation/types.js';
import { WorkspaceIndex } from '../../../../src/navigation/workspace-index.js';
import { ToolExecutor } from '../../../../src/runtime/tool-executor.js';
import { ToolRegistry } from '../../../../src/runtime/tool-registry.js';
import { registerWorkspaceTools } from '../../../../src/runtime/workspace-tools.js';

test('WorkspaceIndex indexes public text kinds and refreshes changed content by hash', async (context) => {
  const root = await fixture(context);
  const index = new WorkspaceIndex(root);
  const first = await index.build(true, true);

  assert.equal(first.files.find((file) => file.path === 'src/model-routing.ts')?.kind, 'source');
  assert.equal(first.files.find((file) => file.path === 'tests/model-routing.test.ts')?.kind, 'test');
  assert.equal(first.files.find((file) => file.path === 'README.md')?.kind, 'docs');
  assert.equal(first.files.find((file) => file.path === 'package.json')?.kind, 'config');
  assert.equal(first.files.some((file) => file.path === '.env.local'), false);
  assert.equal(first.files.some((file) => file.path.includes('node_modules')), false);
  assert.equal(first.files.some((file) => file.path === 'linked-src/model-routing.ts'), false);
  assert.equal(first.packageScripts.test, 'node --test');
  assert.equal(first.files.find((file) => file.path === 'src/model-routing.ts')?.symbols?.[0]?.name, 'RouteEngine');

  const before = first.files.find((file) => file.path === 'src/model-routing.ts')?.contentHash;
  await writeFile(path.join(root, 'src/model-routing.ts'), 'export class RouteEngineV2 {}\n');
  const second = await index.build(true, true);
  assert.notEqual(second.files.find((file) => file.path === 'src/model-routing.ts')?.contentHash, before);
  assert.equal(second.files.find((file) => file.path === 'src/model-routing.ts')?.symbols?.[0]?.name, 'RouteEngineV2');
});

test('NavigationResolver returns direct candidates and a bounded search fallback', async (context) => {
  const root = await fixture(context);
  const features: FeatureIndexEntry[] = [{
    id: 'model-routing',
    title: '模型路由',
    aliases: ['模型选择'],
    triggers: ['route'],
    locations: [
      { path: 'src/model-routing.ts', kind: 'implementation', symbols: ['RouteEngine'], priority: 100 },
      { path: 'tests/model-routing.test.ts', kind: 'test', priority: 70 },
    ],
    searchHints: ['RouteEngine', 'fallback'],
    preferredTools: ['find_symbols', 'read_file'],
  }];
  const resolver = new NavigationResolver(root, features);

  const direct = await resolver.resolve('检查模型路由实现');
  assert.equal(direct?.mode, 'direct');
  assert.equal(direct?.candidatePaths[0], 'src/model-routing.ts');
  assert.equal(direct?.recommendedActions.some((action) => action.tool === 'read_file'), true);
  assert.match(String(direct?.recommendedActions.find((action) => action.tool === 'read_file')
    ?.arguments.expectedContentHash), /^[a-f0-9]{64}$/u);
  assert.ok((direct?.recommendedActions.length ?? 0) <= 4);

  const explicit = await resolver.resolve('检查 src/model-routing.ts 文件');
  assert.equal(explicit?.confidence, 1);
  assert.equal(explicit?.candidatePaths[0], 'src/model-routing.ts');

  const fallback = await resolver.resolve('修复一个未知 bug');
  assert.equal(fallback?.mode, 'search');
  assert.equal(fallback?.recommendedActions[0]?.tool, 'workspace_search');

  const explanation = await resolver.resolve('解释模型路由实现');
  assert.equal(explanation?.mode, 'advisory');

  const fixAfterExplanation = await resolver.resolve('解释问题并修复模型路由实现');
  assert.equal(fixAfterExplanation?.mode, 'direct');

  const explicitSearch = await resolver.resolveForSearch('模型选择');
  assert.equal(explicitSearch?.matches[0]?.featureId, 'model-routing');
});

test('navigation configuration and built-in feature catalog stay bounded', () => {
  assert.equal(parseNavigationMode(undefined), 'auto');
  assert.equal(parseNavigationMode(' auto '), 'auto');
  assert.equal(parseNavigationMode('off'), 'off');
  assert.throws(() => parseNavigationMode('enabled'), /auto 或 off/u);

  assert.deepEqual(ECHOLENS_FEATURES.map((feature) => feature.id), [
    'startup-routing',
    'conversation-runtime',
    'context-mcp-code',
    'approval-sandbox',
    'subagents',
    'model-gateway',
    'evals',
    'workspace-switching',
    'test-workbench',
  ]);
  for (const feature of ECHOLENS_FEATURES) {
    assert.ok(feature.locations.length >= 2 && feature.locations.length <= 5, feature.id);
    assert.ok(feature.searchHints.length >= 3 && feature.searchHints.length <= 8, feature.id);
    assert.ok(feature.locations.some((location) => location.symbols?.length), feature.id);
    assert.ok(feature.preferredTools.length >= 1 && feature.preferredTools.length <= 4, feature.id);
    assert.equal(new Set(feature.locations.map((location) => location.path)).size, feature.locations.length, feature.id);
  }
});

test('local navigation eval cases resolve the planned repository workflows', async (context) => {
  const root = await fixture(context);
  const cases = JSON.parse(await readFile(new URL('../../../fixtures/evals/navigation.cases.json', import.meta.url), 'utf8')) as Array<{
    id: string;
    prompt: string;
    expectedFeatureId: string;
    expectedPath: string;
  }>;
  assert.equal(cases.length, 8);
  const resolver = new NavigationResolver(root);
  for (const evaluation of cases) {
    const result = await resolver.resolve(evaluation.prompt);
    assert.equal(result?.mode, 'direct', evaluation.id);
    assert.equal(result?.matches[0]?.featureId, evaluation.expectedFeatureId, evaluation.id);
    assert.equal(result?.candidatePaths.includes(evaluation.expectedPath), true, evaluation.id);
    assert.equal(result?.recommendedActions.some((action) => action.tool !== 'workspace_search'), true, evaluation.id);
  }
});

test('workspace_search and list_files expose bounded indexed evidence through ToolExecutor', async (context) => {
  const root = await fixture(context);
  const registry = new ToolRegistry();
  registerWorkspaceTools(registry);
  const executor = new ToolExecutor(registry);
  const toolContext = {
    workspaceRoot: root,
    allowedPermissions: new Set<'workspace.read'>(['workspace.read']),
    signal: new AbortController().signal,
  };

  const search = await executor.invoke('workspace_search', { query: 'RouteEngine', limit: 10 }, toolContext);
  assert.equal(search.status, 'ok');
  assert.match(search.content, /src\/model-routing\.ts/u);
  assert.equal(search.evidenceIds.some((id) => id.startsWith('search:src/model-routing.ts')), true);
  const indexedHash = (search.data as { hits: Array<{ path: string; contentHash: string }> }).hits
    .find((hit) => hit.path === 'src/model-routing.ts')?.contentHash;
  assert.ok(indexedHash);

  await writeFile(path.join(root, 'src/model-routing.ts'), 'export class RouteEngineChanged {}\n');
  const staleRead = await executor.invoke('read_file', {
    path: 'src/model-routing.ts', expectedContentHash: indexedHash,
  }, toolContext);
  assert.equal(staleRead.status, 'failed');
  assert.equal(staleRead.error?.code, 'workspace_changed');

  const prioritized = await executor.invoke('workspace_search', { query: 'RouteEngine', limit: 1 }, toolContext);
  assert.equal(prioritized.status, 'ok');
  assert.equal((prioritized.data as { hits: Array<{ kind: string }> }).hits[0]?.kind, 'symbol');

  const docs = await executor.invoke('list_files', { kind: 'docs' }, toolContext);
  assert.equal(docs.status, 'ok');
  assert.match(docs.content, /README\.md/u);
  assert.doesNotMatch(docs.content, /model-routing\.ts/u);
});

async function fixture(context: test.TestContext): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'echolens-navigation-'));
  context.after(async () => rm(root, { recursive: true, force: true }));
  await Promise.all([
    mkdir(path.join(root, 'src/runtime'), { recursive: true }),
    mkdir(path.join(root, 'src/context'), { recursive: true }),
    mkdir(path.join(root, 'tests')),
    mkdir(path.join(root, 'node_modules')),
  ]);
  await Promise.all([
    writeFile(path.join(root, 'src/model-routing.ts'), 'export class RouteEngine {}\n'),
    writeFile(path.join(root, 'src/a-note.ts'), '// RouteEngine is documented here.\n'),
    writeFile(path.join(root, 'src/runtime/model-routing.ts'), 'export function classifyTask() {}\n'),
    writeFile(path.join(root, 'src/runtime/resumable-react-agent.ts'), 'export class ReactAgent {}\n'),
    writeFile(path.join(root, 'src/runtime/tool-executor.ts'), 'export class ToolExecutor {}\n'),
    writeFile(path.join(root, 'src/runtime/workspace-manager.ts'), 'export class WorkspaceRuntimeManager {}\n'),
    writeFile(path.join(root, 'src/context/context-manager.ts'), 'export class ContextManager {}\n'),
    writeFile(path.join(root, 'tests/model-routing.test.ts'), "test('routes models', () => {});\n"),
    writeFile(path.join(root, 'README.md'), '# Routing project\n'),
    writeFile(path.join(root, 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } })),
    writeFile(path.join(root, '.env.local'), 'API_KEY=secret\n'),
    writeFile(path.join(root, 'node_modules/hidden.ts'), 'export const hidden = true;\n'),
  ]);
  await symlink(path.join(root, 'src'), path.join(root, 'linked-src'), process.platform === 'win32' ? 'junction' : 'dir');
  return root;
}
