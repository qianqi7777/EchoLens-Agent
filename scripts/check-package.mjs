import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packageJson = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const manifestPath = join(root, 'package-manifest.json');
const tempRoot = await mkdtemp(join(tmpdir(), 'echolens-package-check-'));

function npmCommand() { return process.platform === 'win32' ? 'npm.cmd' : 'npm'; }
function run(command, args, cwd = root, shell = false) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell,
      windowsHide: true,
      env: { ...process.env, npm_config_cache: join(tempRoot, 'npm-cache') },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', (code) => resolveResult({ code: code ?? 1, stdout, stderr }));
  });
}
function runNpm(args, cwd = root) {
  const npmExecPath = process.env.npm_execpath;
  return npmExecPath
    ? run(process.execPath, [npmExecPath, ...args], cwd)
    : run(npmCommand(), args, cwd, process.platform === 'win32');
}

try {
  if (packageJson.bin?.echolens !== 'dist/cli.js') {
    throw new Error('package.json 的 echolens bin 必须指向 dist/cli.js');
  }
  await access(join(root, 'dist', 'cli.js'));
  const cli = await readFile(join(root, 'dist', 'cli.js'), 'utf8');
  if (!cli.startsWith('#!/usr/bin/env node')) throw new Error('dist/cli.js 缺少 Node shebang');
  await access(join(root, 'dist', 'skills', 'builtin', 'code-search', 'SKILL.md'));

  const tarballDirectory = join(tempRoot, 'tarball');
  const prefix = join(tempRoot, 'global');
  await mkdir(tarballDirectory, { recursive: true });
  const packed = await runNpm(['pack', '--json', '--pack-destination', tarballDirectory]);
  if (packed.code !== 0) throw new Error(`npm pack 失败：${packed.stderr.trim()}`);
  const tarballs = (await readdir(tarballDirectory)).filter((file) => file.endsWith('.tgz'));
  if (tarballs.length !== 1) throw new Error(`期望一个 tarball，实际得到 ${tarballs.length} 个`);
  const tarball = join(tarballDirectory, tarballs[0]);
  const packInfo = JSON.parse(packed.stdout.trim());
  const files = (packInfo[0]?.files ?? []).map((entry) => entry.path).sort();
  const forbidden = /(?:^|[\\/])(?:\.env(?:\.|$)|AGENTS\.md$|studydocs?(?:[\\/]|$)|agent-test(?:[\\/]|$)|\.git(?:[\\/]|$)|server(?:[\\/]|$))/iu;
  const badFiles = files.filter((file) => file !== '.env.example' && forbidden.test(file));
  if (badFiles.length) throw new Error(`发布包包含禁止文件：${badFiles.join(', ')}`);
  if (!files.includes('dist/cli.js')) throw new Error('发布包缺少 dist/cli.js');
  if (!files.includes('dist/skills/builtin/code-search/SKILL.md')) throw new Error('发布包缺少内置 Skill');

  const installed = await runNpm([
    'install', '--global', '--prefix', prefix, '--ignore-scripts', '--no-audit', '--no-fund', tarball,
  ]);
  if (installed.code !== 0) throw new Error(`tarball 安装失败：${installed.stderr.trim()}`);
  const command = process.platform === 'win32' ? join(prefix, 'echolens.cmd') : join(prefix, 'bin', 'echolens');
  const version = process.platform === 'win32'
    // npm creates a .cmd shim on Windows; let Node invoke that shim through its
    // documented shell path instead of manually composing cmd.exe quoting.
    ? await run(command, ['--version'], root, true)
    : await run(command, ['--version'], root);
  if (version.code !== 0 || !version.stdout.includes(String(packageJson.version))) {
    throw new Error(`全局 CLI smoke test 失败：${version.stderr.trim() || version.stdout.trim()}`);
  }

  await writeFile(manifestPath, `${JSON.stringify({ version: packageJson.version, files, command: 'echolens --version' }, null, 2)}\n`, 'utf8');
  console.log(`Package check passed: ${packageJson.name}@${packageJson.version} (${files.length} files)`);
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}
