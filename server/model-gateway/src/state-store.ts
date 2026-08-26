import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export interface DeviceAuthorizationRecord {
  deviceCode: string;
  userCode: string;
  clientId: string;
  scopes: Set<string>;
  expiresAt: number;
  interval: number;
  approved?: { accountId: string; displayName?: string };
  lastPollAt?: number;
}

export interface TokenRecord {
  accountId: string;
  displayName?: string;
  scopes: Set<string>;
  accessExpiresAt: number;
  refreshExpiresAt: number;
  revoked: boolean;
}

export interface IssuedTokenRecord extends TokenRecord {
  accessToken: string;
  refreshToken: string;
}

export interface UsageRecord {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  failures: number;
}

export type RefreshRotationResult =
  | { status: 'ok'; token: TokenRecord }
  | { status: 'invalid' }
  | { status: 'replayed'; accountId: string };

export class GatewayStateStore {
  private readonly database: DatabaseSync;

  constructor(databasePath = ':memory:') {
    if (databasePath !== ':memory:') mkdirSync(dirname(databasePath), { recursive: true });
    this.database = new DatabaseSync(databasePath);
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS device_authorizations (
        device_hash TEXT PRIMARY KEY,
        user_code TEXT NOT NULL UNIQUE,
        client_id TEXT NOT NULL,
        scopes TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        interval_seconds INTEGER NOT NULL,
        account_id TEXT,
        display_name TEXT,
        last_poll_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS tokens (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        access_hash TEXT NOT NULL UNIQUE,
        refresh_hash TEXT NOT NULL UNIQUE,
        account_id TEXT NOT NULL,
        display_name TEXT,
        scopes TEXT NOT NULL,
        access_expires_at INTEGER NOT NULL,
        refresh_expires_at INTEGER NOT NULL,
        revoked INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS tokens_account_idx ON tokens(account_id);
      CREATE TABLE IF NOT EXISTS usage_monthly (
        account_id TEXT NOT NULL,
        period TEXT NOT NULL,
        requests INTEGER NOT NULL DEFAULT 0,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        cached_tokens INTEGER NOT NULL DEFAULT 0,
        failures INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (account_id, period)
      );
    `);
  }

  createDevice(record: DeviceAuthorizationRecord): void {
    this.database.prepare(`
      INSERT INTO device_authorizations
        (device_hash, user_code, client_id, scopes, expires_at, interval_seconds)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(hash(record.deviceCode), record.userCode, record.clientId, encodeScopes(record.scopes), record.expiresAt, record.interval);
  }

  getDevice(deviceCode: string): DeviceAuthorizationRecord | undefined {
    return decodeDevice(this.database.prepare('SELECT * FROM device_authorizations WHERE device_hash = ?').get(hash(deviceCode)), deviceCode);
  }

  getDeviceByUserCode(userCode: string): DeviceAuthorizationRecord | undefined {
    const row = this.database.prepare('SELECT * FROM device_authorizations WHERE user_code = ?').get(userCode);
    return decodeDevice(row, '');
  }

  updateDevice(record: DeviceAuthorizationRecord): void {
    this.database.prepare(`
      UPDATE device_authorizations
      SET account_id = ?, display_name = ?, last_poll_at = ?, interval_seconds = ?
      WHERE device_hash = ?
    `).run(
      record.approved?.accountId ?? null,
      record.approved?.displayName ?? null,
      record.lastPollAt ?? null,
      record.interval,
      hash(record.deviceCode),
    );
  }

  approveDeviceByUserCode(userCode: string, accountId: string, displayName?: string): boolean {
    const result = this.database.prepare(`
      UPDATE device_authorizations SET account_id = ?, display_name = ? WHERE user_code = ?
    `).run(accountId, displayName ?? null, userCode);
    return result.changes === 1;
  }

  deleteDevice(deviceCode: string): void {
    this.database.prepare('DELETE FROM device_authorizations WHERE device_hash = ?').run(hash(deviceCode));
  }

  saveToken(record: IssuedTokenRecord): void {
    this.database.prepare(`
      INSERT INTO tokens
        (access_hash, refresh_hash, account_id, display_name, scopes, access_expires_at, refresh_expires_at, revoked)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      hash(record.accessToken),
      hash(record.refreshToken),
      record.accountId,
      record.displayName ?? null,
      encodeScopes(record.scopes),
      record.accessExpiresAt,
      record.refreshExpiresAt,
      record.revoked ? 1 : 0,
    );
  }

  getAccessToken(accessToken: string): TokenRecord | undefined {
    return decodeToken(this.database.prepare('SELECT * FROM tokens WHERE access_hash = ?').get(hash(accessToken)));
  }

  getRefreshToken(refreshToken: string): TokenRecord | undefined {
    return decodeToken(this.database.prepare('SELECT * FROM tokens WHERE refresh_hash = ?').get(hash(refreshToken)));
  }

  rotateRefresh(refreshToken: string, replacement: IssuedTokenRecord): RefreshRotationResult {
    const row = this.database.prepare('SELECT * FROM tokens WHERE refresh_hash = ?').get(hash(refreshToken));
    const existing = decodeToken(row);
    if (!existing) return { status: 'invalid' };
    if (existing.revoked) {
      this.revokeAccount(existing.accountId);
      return { status: 'replayed', accountId: existing.accountId };
    }
    this.database.exec('BEGIN IMMEDIATE');
    try {
      this.database.prepare('UPDATE tokens SET revoked = 1 WHERE refresh_hash = ?').run(hash(refreshToken));
      this.saveToken(replacement);
      this.database.exec('COMMIT');
      return { status: 'ok', token: existing };
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  revokeToken(token: string): string | undefined {
    const digest = hash(token);
    const row = this.database.prepare('SELECT account_id FROM tokens WHERE access_hash = ? OR refresh_hash = ?').get(digest, digest) as { account_id?: unknown } | undefined;
    if (typeof row?.account_id !== 'string') return undefined;
    this.database.prepare('UPDATE tokens SET revoked = 1 WHERE access_hash = ? OR refresh_hash = ?').run(digest, digest);
    return row.account_id;
  }

  revokeAccount(accountId: string): void {
    this.database.prepare('UPDATE tokens SET revoked = 1 WHERE account_id = ?').run(accountId);
  }

  getUsage(accountId: string, period: string): UsageRecord {
    const row = this.database.prepare(
      'SELECT * FROM usage_monthly WHERE account_id = ? AND period = ?',
    ).get(accountId, period) as Record<string, unknown> | undefined;
    return row ? {
      requests: number(row.requests),
      inputTokens: number(row.input_tokens),
      outputTokens: number(row.output_tokens),
      cachedTokens: number(row.cached_tokens),
      failures: number(row.failures),
    } : emptyUsage();
  }

  recordUsage(accountId: string, period: string, delta: Partial<UsageRecord>): void {
    this.database.prepare(`
      INSERT INTO usage_monthly
        (account_id, period, requests, input_tokens, output_tokens, cached_tokens, failures)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(account_id, period) DO UPDATE SET
        requests = requests + excluded.requests,
        input_tokens = input_tokens + excluded.input_tokens,
        output_tokens = output_tokens + excluded.output_tokens,
        cached_tokens = cached_tokens + excluded.cached_tokens,
        failures = failures + excluded.failures
    `).run(
      accountId,
      period,
      delta.requests ?? 0,
      delta.inputTokens ?? 0,
      delta.outputTokens ?? 0,
      delta.cachedTokens ?? 0,
      delta.failures ?? 0,
    );
  }

  close(): void { this.database.close(); }
}

function decodeDevice(value: unknown, deviceCode: string): DeviceAuthorizationRecord | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const row = value as Record<string, unknown>;
  if (typeof row.user_code !== 'string' || typeof row.client_id !== 'string') return undefined;
  return {
    deviceCode,
    userCode: row.user_code,
    clientId: row.client_id,
    scopes: decodeScopes(row.scopes),
    expiresAt: number(row.expires_at),
    interval: number(row.interval_seconds),
    approved: typeof row.account_id === 'string'
      ? { accountId: row.account_id, displayName: typeof row.display_name === 'string' ? row.display_name : undefined }
      : undefined,
    lastPollAt: typeof row.last_poll_at === 'number' ? row.last_poll_at : undefined,
  };
}

function decodeToken(value: unknown): TokenRecord | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const row = value as Record<string, unknown>;
  if (typeof row.account_id !== 'string') return undefined;
  return {
    accountId: row.account_id,
    displayName: typeof row.display_name === 'string' ? row.display_name : undefined,
    scopes: decodeScopes(row.scopes),
    accessExpiresAt: number(row.access_expires_at),
    refreshExpiresAt: number(row.refresh_expires_at),
    revoked: number(row.revoked) !== 0,
  };
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function encodeScopes(scopes: Set<string>): string { return JSON.stringify([...scopes]); }
function decodeScopes(value: unknown): Set<string> {
  if (typeof value !== 'string') return new Set();
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) && parsed.every((item) => typeof item === 'string')
      ? new Set(parsed) : new Set();
  } catch { return new Set(); }
}
function number(value: unknown): number { return typeof value === 'number' ? value : Number(value); }
function emptyUsage(): UsageRecord { return { requests: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, failures: 0 }; }
