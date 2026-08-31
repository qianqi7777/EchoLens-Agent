import type { JsonSchema } from './types.js';
import {
  compileToolSchema,
  validateToolArguments,
  type ToolArgumentIssue,
} from './tool-schema.js';

export interface PlanStep {
  id: string;
  objective: string;
  verification: string;
  evidenceRequired: string[];
}

export interface AgentPlan {
  objective: string;
  steps: PlanStep[];
  risks: string[];
  completionCriteria: string[];
}

export interface VerifierCheck {
  name: string;
  status: 'passed' | 'failed' | 'unverified';
  summary: string;
  evidenceIds: string[];
}

export interface VerifierOutput {
  status: 'verified' | 'partial' | 'failed';
  checks: VerifierCheck[];
  unresolved: string[];
  warnings: string[];
}

export interface FinalVerification {
  command: string;
  status: 'passed' | 'failed' | 'skipped' | 'timeout' | 'not_run';
  summary: string;
  evidenceIds: string[];
}

export interface FinalSummary {
  answer: string;
  changes: string[];
  verification: FinalVerification[];
  unresolved: string[];
  warnings: string[];
}

export type StructuredOutputIssue = ToolArgumentIssue | {
  path: '/';
  code: 'invalid_json';
  keyword: 'parse';
  message: string;
};

export type StructuredOutputResult<T> =
  | { verified: true; value: T; raw: string; issues: [] }
  | { verified: false; raw: string; issues: StructuredOutputIssue[] };

// 三个输出 Schema 均设 additionalProperties=false 并对字段与条目给出上限，约束模型输出的字段与规模，
// 防止生成超长或无关内容；required 列表保证解析结果具备后续流程所需的最小字段。
export const PLAN_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    objective: { type: 'string', minLength: 1, maxLength: 4000 },
    steps: {
      type: 'array',
      minItems: 1,
      maxItems: 100,
      items: {
        type: 'object',
        properties: {
          id: { type: 'string', minLength: 1, maxLength: 100 },
          objective: { type: 'string', minLength: 1, maxLength: 4000 },
          verification: { type: 'string', minLength: 1, maxLength: 4000 },
          evidenceRequired: {
            type: 'array',
            maxItems: 100,
            items: { type: 'string', minLength: 1, maxLength: 500 },
          },
        },
        required: ['id', 'objective', 'verification', 'evidenceRequired'],
        additionalProperties: false,
      },
    },
    risks: { type: 'array', maxItems: 100, items: { type: 'string', maxLength: 2000 } },
    completionCriteria: {
      type: 'array',
      minItems: 1,
      maxItems: 100,
      items: { type: 'string', minLength: 1, maxLength: 2000 },
    },
  },
  required: ['objective', 'steps', 'risks', 'completionCriteria'],
  additionalProperties: false,
};

export const VERIFIER_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['verified', 'partial', 'failed'] },
    checks: {
      type: 'array',
      maxItems: 200,
      items: {
        type: 'object',
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 500 },
          status: { type: 'string', enum: ['passed', 'failed', 'unverified'] },
          summary: { type: 'string', minLength: 1, maxLength: 4000 },
          evidenceIds: {
            type: 'array',
            maxItems: 200,
            items: { type: 'string', minLength: 1, maxLength: 500 },
          },
        },
        required: ['name', 'status', 'summary', 'evidenceIds'],
        additionalProperties: false,
      },
    },
    unresolved: { type: 'array', maxItems: 200, items: { type: 'string', maxLength: 4000 } },
    warnings: { type: 'array', maxItems: 200, items: { type: 'string', maxLength: 4000 } },
  },
  required: ['status', 'checks', 'unresolved', 'warnings'],
  additionalProperties: false,
};

export const FINAL_SUMMARY_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    answer: { type: 'string', minLength: 1, maxLength: 20_000 },
    changes: { type: 'array', maxItems: 500, items: { type: 'string', maxLength: 4000 } },
    verification: {
      type: 'array',
      maxItems: 500,
      items: {
        type: 'object',
        properties: {
          command: { type: 'string', maxLength: 4000 },
          status: { type: 'string', enum: ['passed', 'failed', 'skipped', 'timeout', 'not_run'] },
          summary: { type: 'string', minLength: 1, maxLength: 4000 },
          evidenceIds: {
            type: 'array',
            maxItems: 500,
            items: { type: 'string', minLength: 1, maxLength: 500 },
          },
        },
        required: ['command', 'status', 'summary', 'evidenceIds'],
        additionalProperties: false,
      },
    },
    unresolved: { type: 'array', maxItems: 500, items: { type: 'string', maxLength: 4000 } },
    warnings: { type: 'array', maxItems: 500, items: { type: 'string', maxLength: 4000 } },
  },
  required: ['answer', 'changes', 'verification', 'unresolved', 'warnings'],
  additionalProperties: false,
};

// strict:true 表示该结构可由 Provider 作为结构化输出（function calling）强制执行；当 Provider 不支持
// 结构化输出时会降级为 parseFinalSummary 解析原始文本，两种路径复用同一份 FINAL_SUMMARY_SCHEMA，保证契约一致。
export const FINAL_SUMMARY_FORMAT = {
  name: 'echolens_final_summary',
  description: 'Verified structure for the final safe-edit agent result.',
  schema: FINAL_SUMMARY_SCHEMA,
  strict: true as const,
};

const planValidator = compileToolSchema('agent_plan', PLAN_SCHEMA);
const verifierValidator = compileToolSchema('verifier_output', VERIFIER_SCHEMA);
const finalSummaryValidator = compileToolSchema('final_summary', FINAL_SUMMARY_SCHEMA);

export function parseAgentPlan(raw: string): StructuredOutputResult<AgentPlan> {
  return parseStructuredOutput(raw, planValidator);
}

export function parseVerifierOutput(raw: string): StructuredOutputResult<VerifierOutput> {
  return parseStructuredOutput(raw, verifierValidator);
}

export function parseFinalSummary(raw: string): StructuredOutputResult<FinalSummary> {
  return parseStructuredOutput(raw, finalSummaryValidator);
}

// 复用 compileToolSchema / validateToolArguments，让结构化输出与工具参数共享同一套严格 schema；
// JSON.parse 失败映射为稳定的 invalid_json 错误码，调用方据此做分支而非解析提示文本。
function parseStructuredOutput<T>(
  raw: string,
  validator: ReturnType<typeof compileToolSchema>,
): StructuredOutputResult<T> {
  let value: unknown;
  try {
    value = JSON.parse(raw.trim()) as unknown;
  } catch {
    return {
      verified: false,
      raw,
      issues: [{ path: '/', code: 'invalid_json', keyword: 'parse', message: '输出不是合法 JSON' }],
    };
  }
  const validation = validateToolArguments(
    validator,
    value as Record<string, unknown>,
  );
  if (!validation.valid) return { verified: false, raw, issues: validation.issues };
  return { verified: true, value: value as T, raw, issues: [] };
}
