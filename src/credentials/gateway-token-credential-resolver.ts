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
    // 该解析器只受理固定引用与 gateway_access 用途，避免被用来读取或刷新不属于它的令牌。
    if (reference !== 'gateway-token:default') return { status: 'unsupported_reference' };
    if (context.purpose !== 'gateway_access') return { status: 'unsupported_reference' };
    const tokens = await this.store.load();
    if (!tokens) return { status: 'missing' };
    const expiresAt = tokens.expiresAt ? Date.parse(tokens.expiresAt) : Number.POSITIVE_INFINITY;
    // 预留 30 秒余量再判定过期，避免令牌在传输或时钟偏差下即将失效时仍被复用。
    if (expiresAt > this.now() + 30_000) {
      return { status: 'resolved', value: tokens.accessToken, expiresAt: tokens.expiresAt };
    }
    // 没有 refresh token 时只能按剩余有效期放行：令牌已过期就返回 missing，绝不复用过期令牌。
    if (!tokens.refreshToken) {
      return expiresAt > this.now()
        ? { status: 'resolved', value: tokens.accessToken, expiresAt: tokens.expiresAt }
        : { status: 'missing' };
    }
    // refresh 必须发往 context.audience（令牌的发行网关）；调用方必须传入可信的权威地址，
    // 否则 refresh token 会被发送到任意宿主。
    try {
      const refreshed = await new GatewayClient({
        gatewayUrl: context.audience,
        accessToken: tokens.accessToken,
        fetch: this.fetchImplementation,
      }).refreshToken(tokens.refreshToken);
      const nextExpiresAt = new Date(this.now() + refreshed.expiresIn * 1000).toISOString();
      // 多路并发刷新时后一次 save 覆盖前一次结果；若网关在服务端一次性消费 refresh token，
      // 并发导致的第二次刷新会失败，随后按旧令牌剩余有效期降级放行，而不是直接报错。
      await this.store.save({
        accessToken: refreshed.accessToken,
        refreshToken: refreshed.refreshToken,
        expiresAt: nextExpiresAt,
        scope: refreshed.scope,
      });
      return { status: 'resolved', value: refreshed.accessToken, expiresAt: nextExpiresAt };
    // 刷新失败的处理策略：旧令牌仍有效则降级继续使用；网关 400/401 表示 refresh token 已失效，
    // 返回 missing 强制重新认证（fail-closed）；其余错误上抛由调用方决定是否重试。
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
