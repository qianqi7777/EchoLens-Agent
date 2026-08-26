import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const suiteNames = ['test:unit', 'test:contract', 'test:security', 'test:performance'] as const;
const packageJson = JSON.parse(await readFile('package.json', 'utf8')) as {
  scripts?: Record<string, string>;
};
const scripts = packageJson.scripts ?? {};
const testRoots = ['src', 'server'].map((directory) => path.resolve(directory));
const testFiles = (await Promise.all(testRoots.map(findTestFiles))).flat().sort();
const errors: string[] = [];

for (const file of testFiles) {
  const relative = path.relative(process.cwd(), file).replaceAll('\\', '/');
  const owners = suiteNames.filter((suite) => scripts[suite]?.includes(relative));
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
    else if (entry.isFile() && entry.name.endsWith('.test.ts')) files.push(target);
  }
  return files.sort();
}
