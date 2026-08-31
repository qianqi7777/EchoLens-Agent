export type MessageRole = 'system' | 'user' | 'assistant';

/**
 * 内容可信度阶梯（system 最高、untrusted 最低），由注入方按来源出处标注，
 * 内容自身无权声明可信度。system 仅用于系统内置消息（如 System Policy）；
 * 指令类规则文件只会落到 user / repository 层级；来源无法确证的内容归入
 * untrusted（fail-closed）。消费方据此决定内容能否影响指令、权限或证据展示。
 */
export type TrustLevel = 'system' | 'organization' | 'user' | 'repository' | 'untrusted';

/**
 * 内容类别，是数据与指令分离的锚点。instruction / user_request 属于指引类；
 * evidence / tool_output 只承载工具执行产生的数据。工具结果必须以 tool_output
 * 形态回填，绝不能用 instruction 身份进入下游。
 */
export type ContextKind = 'instruction' | 'user_request' | 'evidence' | 'tool_output' | 'summary';
export type ToolExecutionStatus = 'ok' | 'denied' | 'invalid' | 'timeout' | 'cancelled' | 'failed';

/**
 * 稳定错误码目录：UI 呈现、评测指标、沙箱适配器与重试策略都按这些字符串
 * 精确匹配或开关行为。新增是向后兼容的；改名或删除必须先审计全部消费方。
 */
export type ToolErrorCode =
  | 'unknown_tool'
  | 'invalid_arguments'
  | 'permission_denied'
  | 'approval_required'
  | 'budget_exhausted'
  | 'timeout'
  | 'cancelled'
  | 'tool_failed'
  | 'patch_invalid'
  | 'patch_context_mismatch'
  | 'patch_ambiguous'
  | 'patch_hash_mismatch'
  | 'patch_target_exists'
  | 'patch_binary_unsupported'
  | 'patch_limits_exceeded'
  | 'patch_workspace_changed'
  | 'patch_apply_failed'
  | 'patch_rollback_failed'
  | 'verification_failed'
  | 'sandbox_unavailable'
  | 'sandbox_invalid_request'
  | 'sandbox_network_denied'
  | 'sandbox_stage_failed'
  | 'sandbox_artifact_failed'
  | 'sandbox_launch_failed'
  | 'mcp_config_invalid'
  | 'mcp_connection_failed'
  | 'mcp_request_failed'
  | 'mcp_tool_error'
  | 'code_intelligence_failed'
  | 'lsp_unavailable'
  | 'lsp_request_failed'
  | 'command_failed';

export interface ToolError {
  code: ToolErrorCode;
  message: string;
  retryable: boolean;
  data?: unknown;
}

export interface TextContentPart {
  type: 'text';
  text: string;
}

export type ContentPart = TextContentPart;

export interface ContextSource {
  type: 'builtin' | 'agents_md' | 'user' | 'file' | 'tool' | 'mcp' | 'web';
  uri?: string;
  toolCallId?: string;
  toolName?: string;
}

export interface ContextItem {
  id: string;
  kind: ContextKind;
  content: string;
  source: ContextSource;
  trust: TrustLevel;
  contentHash?: string;
  truncation?: {
    originalChars: number;
    returnedChars: number;
  };
  redactions: string[];
}

export interface ToolOutputMetadata {
  hashAlgorithm: 'sha256';
  contentHash: string;
  originalChars: number;
  returnedChars: number;
  truncated: boolean;
  // content 已先按脱敏规则处理后才允许回填；redactions 只记录实际命中的
  // 规则类别，供审计与评测引用，下游不得借此请求或还原原始内容。
  redactions: string[];
  guardrailFlags?: string[];
}

export interface MessageItem {
  type: 'message';
  id: string;
  role: MessageRole;
  content: ContentPart[];
}

export interface ToolCallItem {
  type: 'tool_call';
  id: string;
  callId: string;
  name: string;
  arguments: Record<string, unknown>;
  rawArguments?: string;
  argumentParseError?: string;
  callIndex: number;
  dependsOn?: string[];
}

export interface ToolResultItem {
  type: 'tool_result';
  id: string;
  callId: string;
  toolName: string;
  status: ToolExecutionStatus;
  // 工具输出只能作为不可信证据回填：output 恒以 tool_output 数据形态存在，
  // 不得进入指令通道或改变权限集合；evidenceIds 记录支撑结论的证据引用。
  output: ContextItem;
  summary: string;
  data?: unknown;
  error?: ToolError;
  outputMetadata?: ToolOutputMetadata;
  evidenceIds: string[];
}

export type ConversationItem = MessageItem | ToolCallItem | ToolResultItem;

export function textMessage(id: string, role: MessageRole, text: string): MessageItem {
  return { type: 'message', id, role, content: [{ type: 'text', text }] };
}

export function messageText(item: MessageItem): string {
  return item.content
    .filter((part): part is TextContentPart => part.type === 'text')
    .map((part) => part.text)
    .join('');
}

export function isMessageItem(item: ConversationItem): item is MessageItem {
  return item.type === 'message';
}

export function isToolCallItem(item: ConversationItem): item is ToolCallItem {
  return item.type === 'tool_call';
}
