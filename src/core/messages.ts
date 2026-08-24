export type MessageRole = 'system' | 'user' | 'assistant';
export type TrustLevel = 'system' | 'organization' | 'user' | 'repository' | 'untrusted';
export type ContextKind = 'instruction' | 'user_request' | 'evidence' | 'tool_output' | 'summary';
export type ToolExecutionStatus = 'ok' | 'denied' | 'invalid' | 'timeout' | 'cancelled' | 'failed';
export type ToolErrorCode =
  | 'unknown_tool'
  | 'invalid_arguments'
  | 'permission_denied'
  | 'budget_exhausted'
  | 'timeout'
  | 'cancelled'
  | 'tool_failed';

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
  redactions: string[];
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
}

export interface ToolResultItem {
  type: 'tool_result';
  id: string;
  callId: string;
  toolName: string;
  status: ToolExecutionStatus;
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
