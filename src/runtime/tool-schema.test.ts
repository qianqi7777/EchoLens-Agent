import assert from 'node:assert/strict';
import test from 'node:test';
import { ToolExecutor } from './tool-executor.js';
import { ToolRegistry } from './tool-registry.js';
import type { JsonSchema, ToolContext } from './types.js';

const strictSchema: JsonSchema = {
  type: 'object',
  properties: {
    name: { type: 'string', minLength: 2, maxLength: 5 },
    mode: { type: 'string', enum: ['read', 'write'] },
    count: { type: 'integer', minimum: 1, maximum: 3 },
    endpoint: { type: 'string', format: 'uri' },
  },
  required: ['name', 'mode', 'count', 'endpoint'],
  additionalProperties: false,
};

const validArguments = {
  name: 'file',
  mode: 'read',
  count: 2,
  endpoint: 'https://example.test/resource',
};

test('ToolRegistry precompiles strict schemas and rejects unsafe root schemas', () => {
  const registry = new ToolRegistry();
  assert.throws(() => registry.register({
    name: 'unsafe_tool',
    description: 'unsafe',
    permission: 'workspace.read',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: true,
    } as unknown as JsonSchema,
    execute: async () => ({ status: 'ok', content: 'ok', summary: 'ok', evidenceIds: [] }),
  }), /additionalProperties=false/);

  assert.throws(() => registry.register({
    name: 'invalid_format_tool',
    description: 'invalid schema',
    permission: 'workspace.read',
    inputSchema: {
      type: 'object',
      properties: { value: { type: 'string', format: 'unknown-format' } },
      additionalProperties: false,
    },
    execute: async () => ({ status: 'ok', content: 'ok', summary: 'ok', evidenceIds: [] }),
  }), /JSON Schema 无效/);
});

test('ToolExecutor returns field paths and stable codes for invalid arguments', async () => {
  let executions = 0;
  const registry = new ToolRegistry();
  registry.register({
    name: 'schema_tool',
    description: 'schema validation test',
    permission: 'workspace.read',
    inputSchema: strictSchema,
    execute: async () => {
      executions += 1;
      return { status: 'ok', content: 'ok', summary: 'ok', evidenceIds: [] };
    },
  });
  const executor = new ToolExecutor(registry);
  const cases: Array<{
    args: Record<string, unknown>;
    code: string;
    path: string;
  }> = [
    { args: without('name'), code: 'missing_required', path: '/name' },
    { args: { ...validArguments, count: '2' }, code: 'invalid_type', path: '/count' },
    { args: { ...validArguments, extra: true }, code: 'unknown_field', path: '/extra' },
    { args: { ...validArguments, name: 'tool-name' }, code: 'invalid_length', path: '/name' },
    { args: { ...validArguments, mode: 'delete' }, code: 'invalid_enum', path: '/mode' },
    { args: { ...validArguments, count: 10 }, code: 'out_of_range', path: '/count' },
    { args: { ...validArguments, endpoint: 'not a uri' }, code: 'invalid_format', path: '/endpoint' },
  ];

  for (const example of cases) {
    const result = await executor.invoke('schema_tool', example.args, toolContext());
    assert.equal(result.status, 'invalid');
    assert.equal(result.error?.code, 'invalid_arguments');
    const data = result.error?.data as {
      issues: Array<{ code: string; path: string }>;
    };
    assert.equal(data.issues.some(
      (issue) => issue.code === example.code && issue.path === example.path,
    ), true);
  }
  assert.equal(executions, 0);

  const valid = await executor.invoke('schema_tool', validArguments, toolContext());
  assert.equal(valid.status, 'ok');
  assert.equal(executions, 1);
});

function without(key: keyof typeof validArguments): Record<string, unknown> {
  return Object.fromEntries(Object.entries(validArguments).filter(([name]) => name !== key));
}

function toolContext(): ToolContext {
  return {
    workspaceRoot: process.cwd(),
    allowedPermissions: new Set(['workspace.read']),
    signal: new AbortController().signal,
  };
}
