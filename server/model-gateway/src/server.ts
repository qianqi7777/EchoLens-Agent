import { randomBytes, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import type {
  GatewayAuditEvent,
  GatewayModel,
  GatewayProtocol,
  GatewayServerHandle,
  GatewayServerOptions,
} from './types.js';
import {
  GatewayStateStore,
  type DeviceAuthorizationRecord,
  type IssuedTokenRecord,
  type TokenRecord,
} from './state-store.js';
import {
  errorPayload,
  escapeHtml,
  GatewayRequestError,
  isRecord,
  readBody,
  readForm,
  secureEquals,
  writeJson,
} from './http-utils.js';
import {
  createUsageInspector,
  emptyTokenUsage,
  readLimitedResponse,
  sanitizedBody,
  usageFromJson,
} from './proxy-utils.js';

const DEFAULT_SCOPES = new Set(['models:read', 'inference:create', 'usage:read', 'account:read']);
const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';
const MAX_DEFAULT_BODY = 4 * 1024 * 1024;
const MAX_DEFAULT_RESPONSE = 64 * 1024 * 1024;

export function createGatewayServer(options: GatewayServerOptions): GatewayServerHandle & { server: Server } {
  validateOptions(options);
  const now = options.now ?? (() => new Date());
  const randomToken = options.randomToken ?? (() => randomBytes(32).toString('base64url'));
  const state = options.stateStore ?? new GatewayStateStore();
  const activeByAccount = new Map<string, number>();
  const recentByAccount = new Map<string, number[]>();
  const recentAuthByIp = new Map<string, number[]>();
  let closed = false;
  const server = createServer((request, response) => {
    void dispatch(request, response).catch((error) => {
      const requestId = response.getHeader('x-request-id')?.toString() ?? randomUUID();
      if (!response.headersSent && error instanceof GatewayRequestError) {
        writeJson(response, error.status, errorPayload(error.code, requestId, error.retryable, error.message));
      } else if (!response.headersSent) {
        writeJson(response, 500, errorPayload('unknown_gateway_error', requestId, false));
      }
      else response.destroy(error instanceof Error ? error : undefined);
    });
  });

  async function dispatch(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const requestId = randomUUID();
    response.setHeader('x-request-id', requestId);
    response.setHeader('cache-control', 'no-store');
    const method = (request.method ?? 'GET').toUpperCase();
    const url = new URL(request.url ?? '/', 'http://gateway.local');
    if (method === 'GET' && url.pathname === '/health') {
      writeJson(response, 200, { status: 'ok', service_version: '0.1.0' });
      return;
    }
    if (method === 'POST' && url.pathname === '/oauth/device/authorization') {
      if (!allowAuthRequest(request, 10)) {
        response.setHeader('retry-after', '60');
        audit({ type: 'rate_limited', requestId });
        writeJson(response, 429, errorPayload('rate_limited', requestId, true));
        return;
      }
      await createDeviceCode(request, response, requestId);
      return;
    }
    if (method === 'POST' && url.pathname === '/oauth/token') {
      if (!allowAuthRequest(request, 120)) {
        response.setHeader('retry-after', '60');
        audit({ type: 'rate_limited', requestId });
        writeJson(response, 429, errorPayload('rate_limited', requestId, true));
        return;
      }
      await issueToken(request, response, requestId);
      return;
    }
    if (method === 'POST' && url.pathname === '/oauth/revoke') {
      await revokeToken(request, response, requestId);
      return;
    }
    if (method === 'GET' && url.pathname === '/device') {
      const userCode = url.searchParams.get('user_code') ?? '';
      const pending = state.getDeviceByUserCode(userCode);
      if (!pending || pending.expiresAt <= now().getTime()) {
        response.statusCode = 404;
        response.setHeader('content-type', 'text/html; charset=utf-8');
        response.end('<h1>Device Code 不存在或已过期</h1>');
        return;
      }
      if (!options.deviceApprovalSecret) {
        response.statusCode = 503;
        response.setHeader('content-type', 'text/html; charset=utf-8');
        response.end('<h1>Device Flow 审批未配置</h1>');
        return;
      }
      response.statusCode = 200;
      response.setHeader('content-type', 'text/html; charset=utf-8');
      response.end(`<form method="post" action="/device/approve"><input type="hidden" name="user_code" value="${escapeHtml(userCode)}"><label>审批密钥 <input name="approval_secret" type="password" required></label><button type="submit">确认登录 EchoLens Agent</button></form>`);
      return;
    }
    if (method === 'POST' && url.pathname === '/device/approve') {
      const form = await readForm(request);
      if (!options.deviceApprovalSecret || !secureEquals(form.approval_secret ?? '', options.deviceApprovalSecret)) {
        writeJson(response, 403, { error: 'approval_denied' });
        return;
      }
      const pending = state.getDeviceByUserCode(form.user_code ?? '');
      if (!pending || pending.expiresAt <= now().getTime()) {
        writeJson(response, 404, { error: 'invalid_user_code' });
        return;
      }
      state.approveDeviceByUserCode(pending.userCode, 'acct_local', 'Local User');
      response.statusCode = 200;
      response.setHeader('content-type', 'text/html; charset=utf-8');
      response.end('<h1>登录已确认，可以返回 CLI。</h1>');
      return;
    }

    const account = authenticate(request);
    if (!account) {
      const bearer = request.headers.authorization?.startsWith('Bearer ')
        ? request.headers.authorization.slice('Bearer '.length).trim() : undefined;
      const expired = bearer ? state.getAccessToken(bearer) : undefined;
      writeJson(response, 401, errorPayload(expired?.revoked ? 'invalid_token' : expired ? 'token_expired' : 'authentication_required', requestId, false));
      return;
    }
    if (method === 'GET' && url.pathname === '/v1/auth/status') {
      writeJson(response, 200, {
        status: account.accessExpiresAt <= now().getTime() ? 'token_expired' : 'signed_in',
        account: { id: account.accountId, display_name: account.displayName },
        expires_at: new Date(account.accessExpiresAt).toISOString(),
      });
      return;
    }
    if (method === 'GET' && url.pathname === '/v1/me') {
      if (!hasScope(account, 'account:read')) {
        writeJson(response, 403, errorPayload('insufficient_scope', requestId, false));
        return;
      }
      writeJson(response, 200, { id: account.accountId, display_name: account.displayName, scopes: [...account.scopes] });
      return;
    }
    if (method === 'GET' && url.pathname === '/v1/models') {
      if (!hasScope(account, 'models:read')) {
        writeJson(response, 403, errorPayload('insufficient_scope', requestId, false));
        return;
      }
      writeJson(response, 200, { object: 'list', data: allowedModels(account.accountId) });
      return;
    }
    if (method === 'GET' && url.pathname === '/v1/usage') {
      if (!hasScope(account, 'usage:read')) {
        writeJson(response, 403, errorPayload('insufficient_scope', requestId, false));
        return;
      }
      const period = usagePeriod(now());
      writeJson(response, 200, { account_id: account.accountId, period, ...state.getUsage(account.accountId, period) });
      return;
    }
    if (method === 'POST' && (url.pathname === '/v1/chat/completions' || url.pathname === '/v1/responses')) {
      await proxyInference(request, response, requestId, account, url.pathname === '/v1/responses' ? 'responses' : 'chat_completions');
      return;
    }
    writeJson(response, 404, { error: { code: 'not_found', message: 'Gateway 路径不存在', retryable: false }, request_id: requestId });
  }

  async function createDeviceCode(request: IncomingMessage, response: ServerResponse, requestId: string): Promise<void> {
    const form = await readForm(request);
    if (form.client_id !== (options.clientId ?? 'echolens-cli')) {
      writeJson(response, 400, { error: 'invalid_client' });
      return;
    }
    const requestedScopes = (form.scope ?? [...DEFAULT_SCOPES].join(' ')).split(/\s+/u).filter(Boolean);
    if (requestedScopes.some((scope) => !DEFAULT_SCOPES.has(scope))) {
      writeJson(response, 400, { error: 'invalid_scope' });
      return;
    }
    const ttl = options.deviceCodeTtlSeconds ?? 900;
    const deviceCode = randomToken();
    const userCode = `${randomBytes(3).toString('hex').toUpperCase().slice(0, 4)}-${randomBytes(2).toString('hex').toUpperCase()}`;
    state.createDevice({
      deviceCode,
      userCode,
      clientId: form.client_id!,
      scopes: new Set(requestedScopes),
      expiresAt: now().getTime() + ttl * 1000,
      interval: options.devicePollingIntervalSeconds ?? 5,
    });
    audit({ type: 'device_authorization', requestId });
    writeJson(response, 200, {
      device_code: deviceCode,
      user_code: userCode,
      verification_uri: `${options.issuer ?? 'http://localhost'}/device`,
      verification_uri_complete: `${options.issuer ?? 'http://localhost'}/device?user_code=${encodeURIComponent(userCode)}`,
      expires_in: ttl,
      interval: options.devicePollingIntervalSeconds ?? 5,
    });
  }

  async function issueToken(request: IncomingMessage, response: ServerResponse, requestId: string): Promise<void> {
    const form = await readForm(request);
    if (form.grant_type === 'refresh_token') {
      const refreshToken = form.refresh_token ?? '';
      const existing = state.getRefreshToken(refreshToken);
      if (!existing || existing.refreshExpiresAt <= now().getTime()) {
        writeJson(response, 400, { error: 'invalid_grant' });
        return;
      }
      if (existing.revoked) {
        state.revokeAccount(existing.accountId);
        writeJson(response, 400, { error: 'invalid_grant' });
        return;
      }
      const issued = createTokens(existing.accountId, existing.displayName, existing.scopes);
      const rotation = state.rotateRefresh(refreshToken, issued);
      if (rotation.status !== 'ok') {
        writeJson(response, 400, { error: 'invalid_grant' });
        return;
      }
      audit({ type: 'token_issued', requestId, accountId: existing.accountId });
      writeJson(response, 200, tokenPayload(issued, now().getTime()));
      return;
    }
    if (form.grant_type !== DEVICE_GRANT) {
      writeJson(response, 400, { error: 'unsupported_grant_type' });
      return;
    }
    const pending = state.getDevice(form.device_code ?? '');
    if (!pending || pending.clientId !== form.client_id || pending.expiresAt <= now().getTime()) {
      writeJson(response, 400, { error: 'expired_token' });
      return;
    }
    if (pending.lastPollAt && now().getTime() - pending.lastPollAt < pending.interval * 1000) {
      pending.lastPollAt = now().getTime();
      pending.interval += 5;
      state.updateDevice(pending);
      writeJson(response, 400, { error: 'slow_down', interval: pending.interval });
      return;
    }
    pending.lastPollAt = now().getTime();
    state.updateDevice(pending);
    if (!pending.approved) {
      writeJson(response, 400, { error: 'authorization_pending', interval: pending.interval });
      return;
    }
    const issued = createTokens(pending.approved.accountId, pending.approved.displayName, pending.scopes);
    state.saveToken(issued);
    state.deleteDevice(pending.deviceCode);
    audit({ type: 'token_issued', requestId, accountId: pending.approved.accountId });
    writeJson(response, 200, tokenPayload(issued, now().getTime()));
  }

  async function revokeToken(request: IncomingMessage, response: ServerResponse, requestId: string): Promise<void> {
    const form = await readForm(request);
    const accountId = state.revokeToken(form.token ?? '');
    if (accountId) audit({ type: 'token_revoked', requestId, accountId });
    response.statusCode = 200;
    response.end();
  }

  async function proxyInference(
    request: IncomingMessage,
    response: ServerResponse,
    requestId: string,
    account: TokenRecord,
    protocol: GatewayProtocol,
  ): Promise<void> {
    if (!hasScope(account, 'inference:create')) {
      writeJson(response, 403, errorPayload('insufficient_scope', requestId, false));
      return;
    }
    const started = now().getTime();
    const period = usagePeriod(now());
    const disconnect = new AbortController();
    request.once('aborted', () => disconnect.abort('client_disconnected'));
    const active = activeByAccount.get(account.accountId) ?? 0;
    const recent = (recentByAccount.get(account.accountId) ?? []).filter((time) => time > now().getTime() - 60_000);
    if (active >= (options.maxConcurrentRequests ?? 4)
      || recent.length >= (options.maxRequestsPerMinute ?? 60)) {
      audit({ type: 'rate_limited', requestId, accountId: account.accountId, protocol });
      response.setHeader('retry-after', '5');
      writeJson(response, 429, errorPayload('rate_limited', requestId, true));
      return;
    }
    let body: string;
    try {
      body = await readBody(request, options.requestBodyLimitBytes ?? MAX_DEFAULT_BODY);
    } catch (error) {
      if (error instanceof GatewayRequestError) {
        writeJson(response, error.status, errorPayload(error.code, requestId, error.retryable, error.message));
        return;
      }
      throw error;
    }
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(body) as Record<string, unknown>;
    } catch {
      writeJson(response, 400, errorPayload('invalid_request', requestId, false, '请求体不是合法 JSON'));
      return;
    }
    if (!isRecord(parsed) || typeof parsed.model !== 'string') {
      writeJson(response, 400, errorPayload('model_not_allowed', requestId, false, '请求缺少模型')); return;
    }
    const model = options.models.find((candidate) => candidate.id === parsed.model);
    const upstream = model
      ? options.upstreams[`${model.id}:${protocol}`] ?? options.upstreams[model.id]
      : undefined;
    if (!model || !upstream || !model.protocols.includes(protocol) || upstream.protocol !== protocol) {
      writeJson(response, 403, errorPayload('model_not_allowed', requestId, false));
      return;
    }
    if (!allowedModels(account.accountId).some((candidate) => candidate.id === model.id)) {
      writeJson(response, 403, errorPayload('model_not_allowed', requestId, false));
      return;
    }
    const currentUsage = state.getUsage(account.accountId, period);
    if (currentUsage.requests >= (options.monthlyRequestQuota ?? Number.MAX_SAFE_INTEGER)
      || currentUsage.inputTokens + currentUsage.outputTokens >= (options.monthlyTokenQuota ?? Number.MAX_SAFE_INTEGER)) {
      writeJson(response, 429, errorPayload('quota_exceeded', requestId, false));
      return;
    }
    recent.push(now().getTime());
    recentByAccount.set(account.accountId, recent);
    activeByAccount.set(account.accountId, active + 1);
    state.recordUsage(account.accountId, period, { requests: 1 });
    try {
      const fetcher = upstream.fetch ?? globalThis.fetch;
      const upstreamUrl = `${upstream.baseUrl.replace(/\/$/u, '')}/${protocol === 'responses' ? 'responses' : 'chat/completions'}`;
      const timeout = AbortSignal.timeout(options.maxUpstreamDurationMs ?? 120_000);
      const upstreamResponse = await fetcher(upstreamUrl, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${upstream.apiKey}`,
          'content-type': 'application/json',
          'x-request-id': requestId,
        },
        body: sanitizedBody(parsed),
        signal: AbortSignal.any([disconnect.signal, timeout]),
      });
      response.statusCode = upstreamResponse.status;
      response.setHeader('content-type', upstreamResponse.headers.get('content-type') ?? 'application/json');
      response.setHeader('x-upstream-request-id', upstreamResponse.headers.get('x-request-id') ?? requestId);
      const retryAfter = upstreamResponse.headers.get('retry-after');
      if (retryAfter) response.setHeader('retry-after', retryAfter);
      if (!upstreamResponse.ok) {
        state.recordUsage(account.accountId, period, { failures: 1 });
        const mapped = upstreamResponse.status === 429 ? 'rate_limited' : 'upstream_unavailable';
        const payload = errorPayload(
          mapped,
          requestId,
          upstreamResponse.status === 429 || upstreamResponse.status >= 500,
        );
        writeJson(response, upstreamResponse.status >= 500 ? 503 : upstreamResponse.status, payload);
        return;
      }
      if (!upstreamResponse.body) {
        response.end();
        return;
      }
      const contentType = upstreamResponse.headers.get('content-type') ?? 'application/json';
      let resultUsage = emptyTokenUsage();
      const responseLimit = options.maxUpstreamResponseBytes ?? MAX_DEFAULT_RESPONSE;
      if (contentType.includes('text/event-stream')) {
        response.setHeader('content-type', contentType);
        const inspector = createUsageInspector(protocol, responseLimit, (usage) => { resultUsage = usage; });
        await new Promise<void>((resolve, reject) => {
          response.once('finish', resolve);
          response.once('error', reject);
          Readable.fromWeb(upstreamResponse.body as never).pipe(inspector).pipe(response);
        });
      } else {
        const payload = await readLimitedResponse(upstreamResponse, responseLimit);
        try { resultUsage = usageFromJson(JSON.parse(payload.toString('utf8'))); } catch { resultUsage = emptyTokenUsage(); }
        response.end(payload);
      }
      state.recordUsage(account.accountId, period, resultUsage);
      audit({ type: 'model_request', requestId, accountId: account.accountId, model: model.id, protocol, status: upstreamResponse.status, elapsedMs: now().getTime() - started, ...resultUsage });
    } catch (error) {
      state.recordUsage(account.accountId, period, { failures: 1 });
      const timeout = error instanceof Error && error.name === 'TimeoutError';
      if (!response.headersSent && error instanceof GatewayRequestError) {
        writeJson(response, error.status, errorPayload(error.code, requestId, error.retryable, error.message));
      } else if (!response.headersSent) {
        writeJson(response, 503, errorPayload(timeout ? 'upstream_timeout' : 'upstream_unavailable', requestId, true));
      }
      else response.destroy(error instanceof Error ? error : undefined);
    } finally {
      activeByAccount.set(account.accountId, Math.max(0, (activeByAccount.get(account.accountId) ?? 1) - 1));
    }
  }

  function createTokens(accountId: string, displayName: string | undefined, scopes: Set<string>): IssuedTokenRecord {
    const current = now().getTime();
    return {
      accessToken: randomToken(),
      refreshToken: randomToken(),
      accountId,
      displayName,
      scopes: new Set(scopes),
      accessExpiresAt: current + (options.accessTokenTtlSeconds ?? 900) * 1000,
      refreshExpiresAt: current + (options.refreshTokenTtlSeconds ?? 30 * 24 * 3600) * 1000,
      revoked: false,
    };
  }

  function authenticate(request: IncomingMessage): TokenRecord | undefined {
    const value = request.headers.authorization;
    if (!value?.startsWith('Bearer ')) return undefined;
    const accessToken = value.slice('Bearer '.length).trim();
    const record = state.getAccessToken(accessToken);
    if (!record || record.revoked || record.accessExpiresAt <= now().getTime()) return undefined;
    return record;
  }

  function hasScope(token: TokenRecord, scope: string): boolean { return token.scopes.has(scope); }
  function audit(event: GatewayAuditEvent): void {
    try { options.audit?.(event); } catch { /* Audit backends cannot break inference. */ }
  }
  function allowAuthRequest(request: IncomingMessage, limit: number): boolean {
    const key = request.socket.remoteAddress ?? 'unknown';
    const cutoff = now().getTime() - 60_000;
    const recent = (recentAuthByIp.get(key) ?? []).filter((time) => time > cutoff);
    if (recent.length >= limit) return false;
    recent.push(now().getTime());
    recentAuthByIp.set(key, recent);
    return true;
  }
  function allowedModels(accountId: string): GatewayModel[] {
    const allowed = options.entitlements?.[accountId];
    return allowed ? options.models.filter((model) => allowed.includes(model.id)) : options.models;
  }

  return {
    baseUrl: `http://${options.host ?? '127.0.0.1'}:${options.port ?? 0}`,
    server,
    approveDeviceCode(deviceCode, accountId = 'acct_local', displayName = 'Local User') {
      const pending = state.getDevice(deviceCode);
      if (!pending || pending.expiresAt <= now().getTime()) return false;
      pending.approved = { accountId, displayName };
      state.updateDevice(pending);
      return true;
    },
    async close() {
      if (closed) return;
      closed = true;
      if (server.listening) {
        await new Promise<void>((resolve, reject) => {
          server.close((error) => error ? reject(error) : resolve());
        });
      }
      state.close();
    },
  };
}

export async function startGatewayServer(options: GatewayServerOptions): Promise<GatewayServerHandle & { server: Server }> {
  const handle = createGatewayServer(options);
  try {
    await new Promise<void>((resolve, reject) => {
      handle.server.once('error', reject);
      handle.server.listen(options.port ?? 0, options.host ?? '127.0.0.1', resolve);
    });
    const address = handle.server.address();
    if (!address || typeof address === 'string') throw new Error('Gateway 地址解析失败');
    (handle as { baseUrl: string }).baseUrl = `http://${address.address}:${address.port}`;
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

function validateOptions(options: GatewayServerOptions): void {
  if (options.models.length === 0) throw new Error('Gateway 至少需要一个模型');
  for (const model of options.models) {
    const configured = model.protocols.map((protocol) => options.upstreams[`${model.id}:${protocol}`] ?? options.upstreams[model.id]);
    if (configured.some((upstream) => !upstream)) throw new Error(`模型 ${model.id} 缺少固定上游配置`);
    for (const upstream of configured) {
      if (!upstream) continue;
      const url = new URL(upstream.baseUrl);
      if (url.protocol !== 'https:' && !(url.hostname === '127.0.0.1' || url.hostname === 'localhost')) {
        throw new Error('Gateway 上游必须使用 HTTPS，只有本机 Mock 允许 HTTP');
      }
    }
    for (const protocol of model.protocols) {
      const upstream = options.upstreams[`${model.id}:${protocol}`] ?? options.upstreams[model.id];
      if (!upstream || upstream.protocol !== protocol) throw new Error(`模型 ${model.id} 的协议与上游配置不一致`);
    }
  }
  for (const [name, value] of Object.entries({
    requestBodyLimitBytes: options.requestBodyLimitBytes,
    maxConcurrentRequests: options.maxConcurrentRequests,
    maxRequestsPerMinute: options.maxRequestsPerMinute,
    monthlyRequestQuota: options.monthlyRequestQuota,
    monthlyTokenQuota: options.monthlyTokenQuota,
    maxUpstreamDurationMs: options.maxUpstreamDurationMs,
    maxUpstreamResponseBytes: options.maxUpstreamResponseBytes,
  })) {
    if (value !== undefined && (!Number.isFinite(value) || value < 0)) {
      throw new Error(`${name} 必须是非负有限数字`);
    }
  }
}

function tokenPayload(token: IssuedTokenRecord, currentTime: number) {
  return {
    access_token: token.accessToken,
    token_type: 'Bearer',
    expires_in: Math.max(0, Math.floor((token.accessExpiresAt - currentTime) / 1000)),
    refresh_token: token.refreshToken,
    scope: [...token.scopes].join(' '),
  };
}

function usagePeriod(value: Date): string {
  return value.toISOString().slice(0, 7);
}
