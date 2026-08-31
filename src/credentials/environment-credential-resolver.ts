import type { CredentialContext, CredentialResolution, CredentialResolver } from './types.js';

// 引用语法为 env:<名称>；正则限定名称只允许标识符字符，防止把任意字符串当作环境变量引用。
const environmentReference = /^env:([A-Za-z_][A-Za-z0-9_]*)$/;

export class EnvironmentCredentialResolver implements CredentialResolver {
  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

  async resolve(reference: string, _context: CredentialContext): Promise<CredentialResolution> {
    const match = environmentReference.exec(reference);
    if (!match) return { status: 'unsupported_reference' };
    const value = this.env[match[1]!];
    // 空值（含空字符串）视为缺失，不把空值当作有效凭据返回（fail-closed）。
    return value ? { status: 'resolved', value } : { status: 'missing' };
  }
}
