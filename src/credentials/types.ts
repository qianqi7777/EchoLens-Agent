export type CredentialPurpose = 'direct_provider' | 'gateway_access';

export interface CredentialContext {
  purpose: CredentialPurpose;
  audience: string;
}

export type CredentialResolution =
  | { status: 'resolved'; value: string; expiresAt?: string }
  | { status: 'missing' }
  | { status: 'unsupported_reference' };

export interface CredentialResolver {
  resolve(reference: string, context: CredentialContext): Promise<CredentialResolution>;
}
