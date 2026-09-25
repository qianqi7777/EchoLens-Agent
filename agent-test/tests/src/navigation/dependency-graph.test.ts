import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { DependencyGraph } from '../../../../src/navigation/dependency-graph.js';
import { NavigationResolver } from '../../../../src/navigation/navigation-resolver.js';
import type { FeatureIndexEntry } from '../../../../src/navigation/types.js';
import { WorkspaceIndex } from '../../../../src/navigation/workspace-index.js';

test('依赖图解析相对 import、反向依赖并遵守跳数和节点上限', async (context) => {
  const root = await fixture(context);
  const index = new WorkspaceIndex(root);
  const snapshot = await index.build(true, false);
  const graph = new DependencyGraph(root, index).fromSnapshot(snapshot, ['src/a.ts'], { maxHops: 2, maxNodes: 8 });
  assert.deepEqual(graph.roots, ['src/a.ts']);
  assert.deepEqual(graph.paths.sort(), ['src/b.ts', 'src/c.ts', 'src/consumer.ts']);
  assert.ok(graph.edges.some((edge) => edge.from === 'src/a.ts' && edge.to === 'src/b.ts' && edge.relation === 'dependency'));
  assert.ok(graph.edges.some((edge) => edge.from === 'src/consumer.ts' && edge.to === 'src/a.ts' && edge.relation === 'dependent'));
  const capped = new DependencyGraph(root, index).fromSnapshot(snapshot, ['src/a.ts'], { maxHops: 2, maxNodes: 2 });
  assert.equal(capped.paths.length, 1);
  assert.equal(capped.truncated, true);
});

test('NavigationResolver 将依赖图候选追加到首轮导航且保持主文件优先', async (context) => {
  const root = await fixture(context);
  const features: FeatureIndexEntry[] = [{
    id: 'a-feature', title: 'A 模块', aliases: [], triggers: ['a'],
    locations: [{ path: 'src/a.ts', kind: 'implementation', priority: 100 }],
    searchHints: ['a'], preferredTools: ['read_file'],
  }];
  const result = await new NavigationResolver(root, features).resolve('检查 A 模块实现');
  assert.equal(result?.candidatePaths[0], 'src/a.ts');
  assert.ok(result?.candidatePaths.includes('src/b.ts'));
  assert.ok(result?.candidatePaths.includes('src/consumer.ts'));
});

async function fixture(context: test.TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'echolens-dependency-graph-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'src'), { recursive: true });
  await Promise.all([
    writeFile(join(root, 'src/a.ts'), "import { b } from './b.js'; export const a = b;\n"),
    writeFile(join(root, 'src/b.ts'), "import { c } from './c'; export const b = c;\n"),
    writeFile(join(root, 'src/c.ts'), 'export const c = 1;\n'),
    writeFile(join(root, 'src/consumer.ts'), "import { a } from './a'; export const consumer = a;\n"),
    writeFile(join(root, 'src/external.ts'), "import x from 'external-package'; export default x;\n"),
  ]);
  return root;
}
