import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { spawn } from 'node:child_process';
import { JsonGatewayTokenStore, type GatewayTokenStore, type StoredGatewayTokens } from './gateway-token-store.js';

const DPAPI_TYPE = String.raw`
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;

public static class EchoLensDpapi {
  [StructLayout(LayoutKind.Sequential)]
  private struct DataBlob { public int Size; public IntPtr Data; }

  [DllImport("Crypt32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  private static extern bool CryptProtectData(ref DataBlob input, string description, IntPtr entropy, IntPtr reserved, IntPtr prompt, int flags, ref DataBlob output);

  [DllImport("Crypt32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  private static extern bool CryptUnprotectData(ref DataBlob input, IntPtr description, IntPtr entropy, IntPtr reserved, IntPtr prompt, int flags, ref DataBlob output);

  [DllImport("Kernel32.dll", SetLastError = true)]
  private static extern IntPtr LocalFree(IntPtr memory);

  public static byte[] Protect(byte[] value) { return Transform(value, true); }
  public static byte[] Unprotect(byte[] value) { return Transform(value, false); }

  private static byte[] Transform(byte[] value, bool protect) {
    DataBlob input = new DataBlob();
    DataBlob output = new DataBlob();
    try {
      input.Size = value.Length;
      input.Data = Marshal.AllocHGlobal(value.Length);
      Marshal.Copy(value, 0, input.Data, value.Length);
      bool success = protect
        ? CryptProtectData(ref input, "EchoLens Gateway Token", IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, 1, ref output)
        : CryptUnprotectData(ref input, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, 1, ref output);
      if (!success) throw new Win32Exception(Marshal.GetLastWin32Error());
      byte[] result = new byte[output.Size];
      Marshal.Copy(output.Data, result, 0, output.Size);
      return result;
    } finally {
      if (input.Data != IntPtr.Zero) Marshal.FreeHGlobal(input.Data);
      if (output.Data != IntPtr.Zero) LocalFree(output.Data);
    }
  }
}
'@
`;
// 令牌明文只经 stdin 传给 PowerShell 子进程，不拼进 -Command 参数，
// 避免明文出现在进程命令行、系统事件或 PowerShell 运行日志中；DPAPI 桩通过 Add-Type 内联加载。
const SAVE_SCRIPT = `${DPAPI_TYPE}\n$bytes = [Text.Encoding]::UTF8.GetBytes([Console]::In.ReadToEnd()); [Convert]::ToBase64String([EchoLensDpapi]::Protect($bytes))`;
const LOAD_SCRIPT = `${DPAPI_TYPE}\n$bytes = [Convert]::FromBase64String([Console]::In.ReadToEnd().Trim()); [Text.Encoding]::UTF8.GetString([EchoLensDpapi]::Unprotect($bytes))`;

/**
 * 基于 Windows 用户级 DPAPI（Crypt32 的 CryptProtectData/CryptUnprotectData，
 * 使用 CRYPTPROTECT_UI_FORBIDDEN 标志）持久化网关令牌。
 *
 * 密文绑定当前 Windows 用户账户：迁移用户配置文件或更换账户后无法解密，
 * 此时 load 返回 undefined，调用方按“未登录”重新触发认证，不会沿用旧密文。
 * The plaintext token never enters a command line.
 */
export class WindowsProtectedTokenStore implements GatewayTokenStore {
  readonly filePath: string;

  constructor(filePath = resolve(
    process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'),
    'EchoLens',
    'gateway-token.dpapi',
  )) {
    this.filePath = filePath;
  }

  async load(): Promise<StoredGatewayTokens | undefined> {
    if (!existsSync(this.filePath)) return undefined;
    const encrypted = await readFile(this.filePath, 'utf8');
    const plaintext = await powershell(LOAD_SCRIPT, encrypted);
    // 解密、解析失败或结构不合法均按“凭据缺失”返回 undefined：
    // 让损坏文件退化为重新认证，而不是让启动流程崩溃。
    try {
      const value = JSON.parse(plaintext) as Partial<StoredGatewayTokens>;
      if (typeof value.accessToken !== 'string' || !Array.isArray(value.scope)
        || value.scope.some((item) => typeof item !== 'string')) return undefined;
      return {
        accessToken: value.accessToken,
        refreshToken: typeof value.refreshToken === 'string' ? value.refreshToken : undefined,
        expiresAt: typeof value.expiresAt === 'string' ? value.expiresAt : undefined,
        scope: value.scope,
      };
    } catch {
      return undefined;
    }
  }

  async save(tokens: StoredGatewayTokens): Promise<void> {
    const plaintext = JSON.stringify(tokens);
    const encrypted = await powershell(SAVE_SCRIPT, plaintext);
    await mkdir(dirname(this.filePath), { recursive: true });
    // 先写进程独立临时文件再 rename 原子替换，避免读取到半写文件；
    // Windows 上文件保护由 DPAPI 密文承担，0o600 chmod 仅对非 Windows 平台生效。
    const temporary = `${this.filePath}.${process.pid}.tmp`;
    await writeFile(temporary, `${encrypted.trim()}\n`, { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, this.filePath);
    if (process.platform !== 'win32') await chmod(this.filePath, 0o600);
  }

  async clear(): Promise<void> {
    const { unlink } = await import('node:fs/promises');
    await unlink(this.filePath).catch(() => undefined);
  }
}

// 非 Windows 平台没有 DPAPI，回退为 0o600 明文 JSON 文件存储，保护级别由文件权限承担。
export function createDefaultGatewayTokenStore(): GatewayTokenStore {
  return process.platform === 'win32'
    ? new WindowsProtectedTokenStore()
    : new JsonGatewayTokenStore(resolve(homedir(), '.echolens', 'gateway-token.json'));
}

async function powershell(script: string, input: string): Promise<string> {
  return new Promise((resolve, reject) => {
    // -NoProfile/-NonInteractive 避免加载用户配置与交互式执行策略；windowsHide 隐藏控制台窗口。
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const output: Buffer[] = [];
    const errors: Buffer[] = [];
    child.stdout.on('data', (chunk) => output.push(Buffer.from(chunk)));
    child.stderr.on('data', (chunk) => errors.push(Buffer.from(chunk)));
    child.once('error', reject);
    child.once('close', (code) => {
      if (code !== 0) reject(new Error(`Windows DPAPI 操作失败：${Buffer.concat(errors).toString('utf8').trim()}`));
      else resolve(Buffer.concat(output).toString('utf8').trim());
    });
    child.stdin.end(input);
  });
}
