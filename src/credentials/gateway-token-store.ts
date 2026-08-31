import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export interface StoredGatewayTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: string;
  scope: string[];
}

/**
 * 网关令牌持久化接口。
 * 实现必须保证 save 的内容能被 load 完整读回；文件缺失、损坏或解密失败时，
 * load 应返回 undefined，由调用方按“未登录”重新认证，而不是抛出异常。
 */
export interface GatewayTokenStore {
  load(): Promise<StoredGatewayTokens | undefined>;
  save(tokens: StoredGatewayTokens): Promise<void>;
  clear(): Promise<void>;
}

// 明文令牌以 JSON 落盘，仅依赖 0o600 文件权限保护；这是非 Windows 平台的默认实现，
// Windows 上应改用 WindowsProtectedTokenStore 获得 DPAPI 加密。
export class JsonGatewayTokenStore implements GatewayTokenStore {
  readonly filePath: string;

  constructor(filePath = resolve(process.cwd(), '.echolens', 'gateway-token.json')) {
    this.filePath = filePath;
  }

  async load(): Promise<StoredGatewayTokens | undefined> {
    if (!existsSync(this.filePath)) return undefined;
    try {
      // 解析失败或结构不合法时返回 undefined，退化为“未登录”，避免损坏文件导致崩溃。
      const value = JSON.parse(await readFile(this.filePath, 'utf8')) as Partial<StoredGatewayTokens>;
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
    await mkdir(dirname(this.filePath), { recursive: true });
    // 进程独立临时文件 + rename 原子替换，避免读取到半写文件；0o600 chmod 仅对非 Windows 生效。
    const temporary = `${this.filePath}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(tokens)}\n`, { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, this.filePath);
    if (process.platform !== 'win32') await chmod(this.filePath, 0o600);
  }

  async clear(): Promise<void> {
    const { unlink } = await import('node:fs/promises');
    await unlink(this.filePath).catch(() => undefined);
  }
}
