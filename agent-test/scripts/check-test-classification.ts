// 校验每个测试文件恰好归属一个测试套件（unit/contract/security/performance）。
// 只依赖 package.json 的 scripts 与磁盘上的 *.test.ts 文件，无网络与构建步骤，可在 CI 直接跑。
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 套件名必须与 package.json scripts 一一对应；测试文件的归属由各套件命令中的显式路径决定。
const suiteNames = ['test:unit', 'test:contract', 'test:security', 'test:performance'] as const;
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const packageJson = JSON.parse(await readFile(path.join(repoRoot, 'package.json'), 'utf8')) as {
  scripts?: Record<string, string>;
};
const scripts = packageJson.scripts ?? {};
const testRoots = [path.join(repoRoot, 'agent-test/tests')];
const testFiles = (await Promise.all(testRoots.map(findTestFiles))).flat().sort();
const errors: string[] = [];

for (const file of testFiles) {
  const relative = path.relative(repoRoot, file).replaceAll('\\', '/');
  // 归属判定用路径包含而非解析命令：命令里可能带 --test 前缀或按目录展开，路径包含最贴近实际执行范围。
  const owners = suiteNames.filter((suite) => scripts[suite]?.includes(relative));
  // 必须恰好属于一个套件：没有归属说明新测试忘了挂进 npm scripts，多归属说明被重复执行。
  if (owners.length !== 1) {
    errors.push(`${relative}: expected one suite, found ${owners.length} (${owners.join(', ') || 'none'})`);
  }
}

for (const suite of suiteNames) {
  assert.equal(typeof scripts[suite], 'string', `missing package script ${suite}`);
}
assert.deepEqual(errors, [], `test classification errors:\n${errors.join('\n')}`);
process.stdout.write(`classified ${testFiles.length} test files across ${suiteNames.length} suites\n`);

async function findTestFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await findTestFiles(target));
    // 只认 *.test.ts：*.test.tsx 与普通辅助文件不属于被测套件范围，避免误判归属。
    else if (entry.isFile() && entry.name.endsWith('.test.ts')) files.push(target);
  }
  return files.sort();
}
