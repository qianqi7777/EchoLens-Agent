import { cp, mkdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

const compiler = join(root, 'node_modules', 'typescript', 'bin', 'tsc');
const result = await new Promise((resolveResult, reject) => {
  const child = spawn(process.execPath, [compiler, '-p', 'tsconfig.build.json'], {
    cwd: root,
    stdio: 'inherit',
    shell: false,
    windowsHide: true,
  });
  child.once('error', reject);
  child.once('exit', (code) => resolveResult(code ?? 1));
});
if (result !== 0) process.exit(result);

await cp(join(root, 'src', 'skills', 'builtin'), join(dist, 'skills', 'builtin'), { recursive: true });
console.log(`Built ${dist}`);
