import type { CredentialContext, CredentialResolution, CredentialResolver } from './types.js';

const environmentReference = /^env:([A-Za-z_][A-Za-z0-9_]*)$/;

export class EnvironmentCredentialResolver implements CredentialResolver {
  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

  async resolve(reference: string, _context: CredentialContext): Promise<CredentialResolution> {
    const match = environmentReference.exec(reference);
    if (!match) return { status: 'unsupported_reference' };
    const value = this.env[match[1]!];
    return value ? { status: 'resolved', value } : { status: 'missing' };
  }
}
