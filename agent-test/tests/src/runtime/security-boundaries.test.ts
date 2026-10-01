import assert from 'node:assert/strict';
import test from 'node:test';
import { PathPolicyError, validatePatchPath, validateRelativePath } from '../../../../src/runtime/path-policy.js';

function rejectsCode(action: () => void, code: string): void {
  assert.throws(action, (error: unknown) => error instanceof PathPolicyError && error.code === code);
}

test('安全边界拒绝空路径', () => rejectsCode(() => validateRelativePath(''), 'invalid_path'));
test('安全边界拒绝 NUL 字节路径', () => rejectsCode(() => validateRelativePath('safe\0file'), 'invalid_path'));
test('安全边界拒绝超长路径', () => rejectsCode(() => validateRelativePath('a'.repeat(32_001)), 'path_too_long'));
test('安全边界拒绝 POSIX 绝对路径', () => rejectsCode(() => validateRelativePath('/etc/passwd'), 'absolute_path'));
test('安全边界拒绝 Windows 绝对路径', () => rejectsCode(() => validateRelativePath('C:\\workspace\\file.ts'), 'absolute_path'));
test('安全边界拒绝 UNC 路径', () => rejectsCode(() => validateRelativePath('\\\\server\\share\\file.ts'), 'unc_path'));
test('安全边界拒绝设备命名空间路径', () => rejectsCode(() => validateRelativePath('\\\\?\\C:\\workspace\\file.ts'), 'device_path'));
test('安全边界拒绝盘符相对路径', () => rejectsCode(() => validateRelativePath('C:relative.ts'), 'drive_relative_path'));
test('安全边界拒绝父目录穿越', () => rejectsCode(() => validateRelativePath('src/../../outside.ts'), 'path_outside_workspace'));
test('安全边界拒绝 NTFS ADS', () => rejectsCode(() => validateRelativePath('report.txt:secret'), 'alternate_data_stream'));
test('安全边界拒绝通配符路径', () => rejectsCode(() => validateRelativePath('src/*.ts'), 'invalid_path'));
test('安全边界拒绝控制字符路径', () => rejectsCode(() => validateRelativePath('src/\u0001.ts'), 'invalid_path'));
test('安全边界拒绝尾随点组件', () => rejectsCode(() => validateRelativePath('src/file.'), 'trailing_dot_or_space'));
test('安全边界拒绝尾随空格组件', () => rejectsCode(() => validateRelativePath('src/file '), 'trailing_dot_or_space'));
test('安全边界拒绝 8.3 短名称', () => rejectsCode(() => validateRelativePath('SOURCE~1/config.ts'), 'short_name'));
test('安全边界拒绝 CON 保留设备名', () => rejectsCode(() => validateRelativePath('CON.txt'), 'reserved_name'));
test('安全边界拒绝 COM1 保留设备名', () => rejectsCode(() => validateRelativePath('COM1.log'), 'reserved_name'));
test('安全边界拒绝 LPT9 保留设备名', () => rejectsCode(() => validateRelativePath('LPT9.out'), 'reserved_name'));
test('安全边界拒绝 .git 元数据目录', () => rejectsCode(() => validateRelativePath('src/.git/config'), 'git_metadata_denied'));
test('安全边界拒绝 .echolens 私有目录', () => rejectsCode(() => validateRelativePath('.echolens/events.jsonl'), 'private_metadata_denied'));
test('安全边界拒绝混合分隔符穿越', () => rejectsCode(() => validateRelativePath('src\\..\\..\\outside.ts'), 'path_outside_workspace'));
test('Patch 边界拒绝绝对路径中的 ADS', () => rejectsCode(() => validatePatchPath('C:\\authorized\\file.txt:secret'), 'alternate_data_stream'));
test('Patch 边界拒绝绝对路径中的穿越', () => rejectsCode(() => validatePatchPath('C:\\authorized\\..\\outside.txt'), 'path_outside_workspace'));
test('Patch 边界拒绝绝对路径中的非法字符', () => rejectsCode(() => validatePatchPath('C:\\authorized\\bad|name.txt'), 'invalid_path'));
test('Patch 边界允许干净绝对路径交由授权根判定', () => {
  assert.doesNotThrow(() => validatePatchPath('C:\\authorized\\file.txt'));
  assert.doesNotThrow(() => validatePatchPath('/authorized/file.txt'));
});
