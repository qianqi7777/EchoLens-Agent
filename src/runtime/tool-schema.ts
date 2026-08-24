import Ajv, { type ErrorObject, type ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';
import type { JsonSchema } from './types.js';

export type ToolArgumentErrorCode =
  | 'missing_required'
  | 'invalid_type'
  | 'unknown_field'
  | 'invalid_enum'
  | 'out_of_range'
  | 'invalid_length'
  | 'invalid_format'
  | 'schema_violation';

export interface ToolArgumentIssue {
  path: string;
  code: ToolArgumentErrorCode;
  keyword: string;
  message: string;
}

export type ToolArgumentValidation =
  | { valid: true; issues: [] }
  | { valid: false; issues: ToolArgumentIssue[] };

const ajv = new Ajv({
  strict: true,
  allErrors: true,
  coerceTypes: false,
  allowUnionTypes: true,
  removeAdditional: false,
  useDefaults: false,
});
addFormats(ajv);

export function compileToolSchema(toolName: string, schema: JsonSchema): ValidateFunction {
  if (schema.type !== 'object' || schema.additionalProperties !== false) {
    throw new Error(`工具 ${toolName} 的根 Schema 必须是 object 且 additionalProperties=false`);
  }
  try {
    return ajv.compile(schema);
  } catch (error) {
    throw new Error(
      `工具 ${toolName} 的 JSON Schema 无效：${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function validateToolArguments(
  validator: ValidateFunction,
  args: Record<string, unknown>,
): ToolArgumentValidation {
  if (validator(args)) return { valid: true, issues: [] };
  return {
    valid: false,
    issues: (validator.errors ?? []).map(argumentIssue),
  };
}

function argumentIssue(error: ErrorObject): ToolArgumentIssue {
  return {
    path: issuePath(error),
    code: issueCode(error.keyword),
    keyword: error.keyword,
    message: error.message ?? '参数不符合 Schema',
  };
}

function issuePath(error: ErrorObject): string {
  const base = error.instancePath || '';
  if (error.keyword === 'required' && typeof error.params.missingProperty === 'string') {
    return `${base}/${escapePointer(error.params.missingProperty)}` || '/';
  }
  if (error.keyword === 'additionalProperties' && typeof error.params.additionalProperty === 'string') {
    return `${base}/${escapePointer(error.params.additionalProperty)}` || '/';
  }
  return base || '/';
}

function issueCode(keyword: string): ToolArgumentErrorCode {
  if (keyword === 'required') return 'missing_required';
  if (keyword === 'type') return 'invalid_type';
  if (keyword === 'additionalProperties') return 'unknown_field';
  if (keyword === 'enum' || keyword === 'const') return 'invalid_enum';
  if (['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum'].includes(keyword)) {
    return 'out_of_range';
  }
  if (['minLength', 'maxLength', 'minItems', 'maxItems'].includes(keyword)) return 'invalid_length';
  if (keyword === 'format' || keyword === 'pattern') return 'invalid_format';
  return 'schema_violation';
}

function escapePointer(value: string): string {
  return value.replaceAll('~', '~0').replaceAll('/', '~1');
}
