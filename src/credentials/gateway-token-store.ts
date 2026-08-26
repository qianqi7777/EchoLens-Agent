import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export interface StoredGatewayTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: string;
  scope: string[];
}

export interface GatewayTokenStore {
  load(): Promise<StoredGatewayTokens | undefined>;
  save(tokens: StoredGatewayTokens): Promise<void>;
  clear(): Promise<void>;
}

export class JsonGatewayTokenStore implements GatewayTokenStore {
  readonly filePath: string;

  constructor(filePath = resolve(process.cwd(), '.echolens', 'gateway-token.json')) {
    this.filePath = filePath;
  }

  async load(): Promise<StoredGatewayTokens | undefined> {
    if (!existsSync(this.filePath)) return undefined;
    try {
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
