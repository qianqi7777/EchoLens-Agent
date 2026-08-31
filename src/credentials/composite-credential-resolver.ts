import type { CredentialContext, CredentialResolution, CredentialResolver } from './types.js';

export class CompositeCredentialResolver implements CredentialResolver {
  constructor(private readonly resolvers: readonly CredentialResolver[]) {}

  async resolve(reference: string, context: CredentialContext): Promise<CredentialResolution> {
    // 按注册顺序构成优先级链：unsupported_reference 表示该解析器不顺位处理，继续尝试下一个；
    // 一旦某个解析器返回 missing 或 resolved 即终止链——明确判定凭据缺失时，
    // 不会继续回退到优先级更低的来源（fail-closed）。
    for (const resolver of this.resolvers) {
      const result = await resolver.resolve(reference, context);
      if (result.status !== 'unsupported_reference') return result;
    }
    return { status: 'unsupported_reference' };
  }
}
