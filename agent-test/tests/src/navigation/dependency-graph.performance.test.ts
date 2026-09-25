import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { DependencyGraph } from '../../../../src/navigation/dependency-graph.js';
import { WorkspaceIndex } from '../../../../src/navigation/workspace-index.js';

test('依赖图在大工作区保持节点上限', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'echolens-dependency-performance-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'src'), { recursive: true });
  const files = Array.from({ length: 600 }, (_, index) => {
    const next = index + 1 < 600 ? `import { value } from './file-${index + 1}';\n` : '';
    return writeFile(join(root, 'src', `file-${index}.ts`), `${next}export const value = ${index};\n`);
  });
  await Promise.all(files);
  const index = new WorkspaceIndex(root);
  const snapshot = await index.build(true, false);
  const result = new DependencyGraph(root, index).fromSnapshot(snapshot, ['src/file-0.ts'], { maxHops: 2, maxNodes: 32 });
  assert.ok(result.paths.length <= 31);
  assert.ok(result.edges.length <= 64);
  assert.equal(result.roots[0], 'src/file-0.ts');
});
