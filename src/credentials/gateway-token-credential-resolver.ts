import { createDefaultGatewayTokenStore } from './windows-protected-token-store.js';
import type { GatewayTokenStore } from './gateway-token-store.js';
import type { CredentialContext, CredentialResolution, CredentialResolver } from './types.js';
import { GatewayClient, GatewayClientError } from '../providers/gateway/client.js';

export class GatewayTokenCredentialResolver implements CredentialResolver {
  constructor(
    private readonly store: GatewayTokenStore = createDefaultGatewayTokenStore(),
    private readonly fetchImplementation?: typeof globalThis.fetch,
    private readonly now: () => number = Date.now,
  ) {}

  async resolve(reference: string, context: CredentialContext): Promise<CredentialResolution> {
    if (reference !== 'gateway-token:default') return { status: 'unsupported_reference' };
    if (context.purpose !== 'gateway_access') return { status: 'unsupported_reference' };
    const tokens = await this.store.load();
    if (!tokens) return { status: 'missing' };
    const expiresAt = tokens.expiresAt ? Date.parse(tokens.expiresAt) : Number.POSITIVE_INFINITY;
    if (expiresAt > this.now() + 30_000) {
      return { status: 'resolved', value: tokens.accessToken, expiresAt: tokens.expiresAt };
    }
    if (!tokens.refreshToken) {
      return expiresAt > this.now()
        ? { status: 'resolved', value: tokens.accessToken, expiresAt: tokens.expiresAt }
        : { status: 'missing' };
    }
    try {
      const refreshed = await new GatewayClient({
        gatewayUrl: context.audience,
        accessToken: tokens.accessToken,
        fetch: this.fetchImplementation,
      }).refreshToken(tokens.refreshToken);
      const nextExpiresAt = new Date(this.now() + refreshed.expiresIn * 1000).toISOString();
      await this.store.save({
        accessToken: refreshed.accessToken,
        refreshToken: refreshed.refreshToken,
        expiresAt: nextExpiresAt,
        scope: refreshed.scope,
      });
      return { status: 'resolved', value: refreshed.accessToken, expiresAt: nextExpiresAt };
    } catch (error) {
      if (expiresAt > this.now()) {
        return { status: 'resolved', value: tokens.accessToken, expiresAt: tokens.expiresAt };
      }
      if (error instanceof GatewayClientError && (error.status === 400 || error.status === 401)) {
        return { status: 'missing' };
      }
      throw error;
    }
  }
}
