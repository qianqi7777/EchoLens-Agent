export type CredentialPurpose = 'direct_provider' | 'gateway_access';

/**
 * 凭据解析上下文。
 * audience 声明凭据将被使用的目标（如网关地址或 Provider 端点）；
 * 解析器不应把凭据交给 audience 之外的其他宿主。
 */
export interface CredentialContext {
  purpose: CredentialPurpose;
  audience: string;
}

/**
 * 凭据解析结果。
 * resolved 携带凭据值及可选过期时间；missing 表示解析器受理了该引用但没有可用值，
 * 会终止解析链（fail-closed）；unsupported_reference 表示解析器不处理该引用，链继续向后尝试。
 */
export type CredentialResolution =
  | { status: 'resolved'; value: string; expiresAt?: string }
  | { status: 'missing' }
  | { status: 'unsupported_reference' };

export interface CredentialResolver {
  resolve(reference: string, context: CredentialContext): Promise<CredentialResolution>;
}
