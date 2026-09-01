import Ajv, { type ErrorObject, type ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';
import type { JsonSchema, JsonSchemaNode } from './types.js';

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

export function objectSchema(
  properties: Record<string, JsonSchemaNode>,
  required: string[] = [],
): JsonSchema {
  return { type: 'object', properties, required, additionalProperties: false };
}

// 工具参数视为不可信输入：关闭类型强转、默认值注入与额外字段剥离，只做严格校验。
// 未知字段依赖 schema 的 additionalProperties=false 报错而非静默剪除，防止参数漂移或原型污染。
const ajv = new Ajv({
  strict: true,
  allErrors: true,
  coerceTypes: false,
  allowUnionTypes: true,
  removeAdditional: false,
  useDefaults: false,
});
addFormats(ajv);

// 根 Schema 必须为 object 且 additionalProperties=false：工具参数来自模型，入口处即拒绝非对象输入
// 与未知字段，否则松散 schema 会让后面的校验形同虚设。
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

// required / additionalProperties 的错误 instancePath 不指向具体字段，需从 params 取出字段名拼成
// /path/field，供调用方定位到出错参数；字段名中的 / 与 ~ 按 JSON Pointer 规则转义。
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

// 把 Ajv keyword 映射为面向调用方的稳定错误码。调用方依赖 code 做分支判断，不依赖可能变化的英文 message。
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
