import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const suites = JSON.parse(await readFile(path.join(root, 'agent-test/test-suites.json'), 'utf8')) as Record<string, string[]>;
const names = ['unit', 'contract', 'security', 'performance'];
assert.deepEqual(Object.keys(suites).sort(), [...names].sort());
assert.ok(Object.values(suites).every((files) => Array.isArray(files) && files.length > 0
  && files.every((file) => typeof file === 'string' && /^agent-test\/tests\/.+\.test\.ts$/u.test(file))));
const registered = Object.values(suites).flat();
assert.equal(new Set(registered).size, registered.length, '测试文件不能重复归类');
const actual = (await readdir(path.join(root, 'agent-test/tests'), { recursive: true }))
  .filter((file) => file.endsWith('.test.ts'))
  .map((file) => `agent-test/tests/${file.replaceAll('\\', '/')}`);
assert.deepEqual([...registered].sort(), actual.sort(), '测试分类必须与磁盘文件一致');

const [suite, ...options] = process.argv.slice(2);
if (suite === '--check') {
  console.log(`classified ${actual.length} test files across ${names.length} suites`);
} else {
  assert.ok(suite && names.includes(suite), '用法：run-tests.ts <unit|contract|security|performance|--check>');
  // 用当前 Node 和 argv 启动，Windows 无需 .cmd/Shell；保留每个测试文件的进程隔离。
  const child = spawn(process.execPath, ['--import', 'tsx', '--test', ...options, ...suites[suite]!], {
    cwd: root, stdio: 'inherit', shell: false,
  });
  process.exitCode = await new Promise<number>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => resolve(code ?? 1));
  });
}
