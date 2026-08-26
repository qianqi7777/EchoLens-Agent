import type { CredentialContext, CredentialResolution, CredentialResolver } from './types.js';

export class CompositeCredentialResolver implements CredentialResolver {
  constructor(private readonly resolvers: readonly CredentialResolver[]) {}

  async resolve(reference: string, context: CredentialContext): Promise<CredentialResolution> {
    for (const resolver of this.resolvers) {
      const result = await resolver.resolve(reference, context);
      if (result.status !== 'unsupported_reference') return result;
    }
    return { status: 'unsupported_reference' };
  }
}
