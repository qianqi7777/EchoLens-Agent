export type PermissionProfile = 'read-only' | 'auto' | 'full';

export const DEFAULT_PERMISSION_PROFILE: PermissionProfile = 'auto';

export function parsePermissionProfile(value: string | undefined): PermissionProfile {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return DEFAULT_PERMISSION_PROFILE;
  if (normalized === 'read-only' || normalized === 'auto' || normalized === 'full') return normalized;
  throw new Error('AGENT_PERMISSION_PROFILE 必须为 read-only、auto 或 full');
}
