import assert from 'node:assert/strict';
import {
  mkdir,
  mkdtemp,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { PathPolicy, PathPolicyError } from '../../../../src/runtime/path-policy.js';

test('PathPolicy rejects Windows namespace, ADS, short-name, reserved, and escape syntax', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'echolens-path-policy-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const policy = await PathPolicy.create(root);
  // 每个用例都是一个攻击样本，覆盖 Windows 命名空间、UNC、ADS、8.3 短名、保留设备名、
  // 路径穿越与元数据目录；validateRelativePath 必须为每一类返回稳定的 error code。
  const cases: Array<{ input: string; code: string }> = [
    { input: '..\\outside.ts', code: 'path_outside_workspace' },
    { input: join(root, 'absolute.ts'), code: 'absolute_path' },
    { input: '\\\\server\\share\\file.ts', code: 'unc_path' },
    { input: '\\\\?\\C:\\workspace\\file.ts', code: 'device_path' },
    { input: '\\\\.\\C:\\workspace\\file.ts', code: 'device_path' },
    { input: 'C:relative.ts', code: 'drive_relative_path' },
    { input: 'file.ts:secret', code: 'alternate_data_stream' },
    { input: 'SOURCE~1\\file.ts', code: 'short_name' },
    { input: 'CON.txt', code: 'reserved_name' },
    { input: 'folder.\\file.ts', code: 'trailing_dot_or_space' },
    { input: '.git\\config', code: 'git_metadata_denied' },
    { input: '.echolens\\sessions\\private.jsonl', code: 'private_metadata_denied' },
  ];

  for (const example of cases) {
    await assert.rejects(policy.resolveExisting(example.input), (error: unknown) => {
      assert.ok(error instanceof PathPolicyError);
      assert.equal(error.code, example.code);
      return true;
    });
  }
});

test('PathPolicy reads normal files through a verified handle and preserves Windows case-insensitivity', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'echolens-path-normal-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'CaseFile.ts'), 'export const value = 1;\n', 'utf8');
  await writeFile(join(root, 'value~1copy.ts'), 'export const allowed = true;\n', 'utf8');
  const policy = await PathPolicy.create(root);

  const exact = await policy.readTextFile('CaseFile.ts');
  assert.match(exact.content, /value = 1/);
  assert.match((await policy.readTextFile('value~1copy.ts')).content, /allowed = true/);
  // Windows 文件系统大小写不敏感：不同大小写会命中同一文件，且 canonicalPath 保留实际写入的
  // 大小写，故形如 casefile.ts 的读取与精确大小写读取结果一致。POSIX 无此行为。
  if (process.platform === 'win32') {
    const differentCase = await policy.readTextFile('casefile.ts');
    assert.equal(differentCase.content, exact.content);
  }
});

test('PathPolicy rejects file symlinks and directory junctions', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'echolens-path-links-'));
  const outside = await mkdtemp(join(tmpdir(), 'echolens-path-outside-'));
  t.after(() => Promise.all([
    rm(root, { recursive: true, force: true }),
    rm(outside, { recursive: true, force: true }),
  ]));
  const outsideFile = join(outside, 'secret.ts');
  await writeFile(outsideFile, 'outside secret', 'utf8');
  // Junction 在 Windows 上无需提权即可创建，是最易被滥用的重解析点；这里验证它会被拒绝。
  await symlink(outside, join(root, 'junction'), process.platform === 'win32' ? 'junction' : 'dir');
  const policy = await PathPolicy.create(root);

  await assert.rejects(policy.readTextFile('junction\\secret.ts'), (error: unknown) => {
    assert.ok(error instanceof PathPolicyError);
    assert.equal(error.code, 'reparse_point_denied');
    return true;
  });

  try {
    await symlink(outsideFile, join(root, 'file-link.ts'), 'file');
  } catch (error) {
    // Windows 默认不允许普通用户创建文件符号链接（需 Developer Mode 或提权），EPERM 时放弃
    // 文件链接用例，仅保留已验证的 Junction 拒绝分支，避免测试在该环境下稳定失败。
    if (isNodeError(error) && error.code === 'EPERM') {
      t.diagnostic('Windows 未授予创建文件符号链接的权限；Junction 拒绝已验证。');
      return;
    }
    throw error;
  }
  await assert.rejects(policy.readTextFile('file-link.ts'), (error: unknown) => {
    assert.ok(error instanceof PathPolicyError);
    assert.equal(error.code, 'reparse_point_denied');
    return true;
  });
});

test('PathPolicy detects target replacement after the file handle is opened', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'echolens-path-race-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const target = join(root, 'target.ts');
  const replacement = join(root, 'replacement.ts');
  const original = join(root, 'original.ts');
  await writeFile(target, 'original', 'utf8');
  await writeFile(replacement, 'replacement', 'utf8');
  // afterHandleOpen 在“打开句柄”与“重新解析并比对 dev/ino”之间执行，测试借此在单线程内
  // 确定性地复现 rename-after-open 竞态；swapped 保证只替换一次，避免影响后续断言。
  let swapped = false;
  const policy = await PathPolicy.create(root, {
    afterHandleOpen: async ({ kind }) => {
      if (kind !== 'file' || swapped) return;
      swapped = true;
      await rename(target, original);
      await rename(replacement, target);
    },
  });

  await assert.rejects(policy.readTextFile('target.ts'), (error: unknown) => {
    assert.ok(error instanceof PathPolicyError);
    assert.equal(error.code, 'handle_identity_mismatch');
    return true;
  });
});

test('PathPolicy rejects text files above the configured read limit', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'echolens-path-size-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'large.ts'), 'x'.repeat(11), 'utf8');
  const policy = await PathPolicy.create(root);

  await assert.rejects(policy.readTextFile('large.ts', 10), (error: unknown) => {
    assert.ok(error instanceof PathPolicyError);
    assert.equal(error.code, 'file_too_large');
    return true;
  });
});

test('workspace tools reject explicit junction traversal with a structured path policy code', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'echolens-workspace-links-'));
  const outside = await mkdtemp(join(tmpdir(), 'echolens-workspace-outside-'));
  t.after(() => Promise.all([
    rm(root, { recursive: true, force: true }),
    rm(outside, { recursive: true, force: true }),
  ]));
  await mkdir(join(root, 'src'));
  await writeFile(join(outside, 'secret.ts'), 'outside', 'utf8');
  await symlink(outside, join(root, 'src', 'linked'), process.platform === 'win32' ? 'junction' : 'dir');

  const { ToolExecutor } = await import('../../../../src/runtime/tool-executor.js');
  const { ToolRegistry } = await import('../../../../src/runtime/tool-registry.js');
  const { registerWorkspaceTools } = await import('../../../../src/runtime/workspace-tools.js');
  const registry = new ToolRegistry();
  registerWorkspaceTools(registry);
  // 显式用反斜杠穿越 Junction，验证 deny 路径通过工具层把内部 pathPolicyCode 作为结构化
  // 错误数据传给调用方，而不只是一条文本消息。
  const result = await new ToolExecutor(registry).invoke('read_file', {
    path: 'src\\linked\\secret.ts',
  }, {
    workspaceRoot: root,
    allowedPermissions: new Set(['workspace.read']),
    signal: new AbortController().signal,
  });

  assert.equal(result.status, 'denied');
  assert.equal(result.error?.code, 'permission_denied');
  assert.deepEqual(result.error?.data, { pathPolicyCode: 'reparse_point_denied' });
});

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error;
}
