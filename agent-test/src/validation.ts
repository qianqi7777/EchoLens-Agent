import Ajv from 'ajv';
import type { IssueSet } from './types.js';

const text = (maxLength: number) => ({ type: 'string', maxLength });
const validate = new Ajv({ allErrors: true }).compile({
  type: 'object', required: ['repo', 'issues'], additionalProperties: false,
  properties: {
    repo: { ...text(300), minLength: 1 },
    issues: { type: 'array', minItems: 1, maxItems: 100, items: {
      type: 'object', required: ['id', 'title'], additionalProperties: false,
      properties: {
        id: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$' },
        title: { ...text(2000), minLength: 1 }, body: text(100000),
        number: { type: 'integer', minimum: 1 }, state: text(30),
        checks: { type: 'array', maxItems: 50, items: {
          type: 'object', required: ['id', 'command'], additionalProperties: false,
          properties: {
            id: { ...text(128), minLength: 1 }, cwd: text(500), stdoutIncludes: text(10000),
            timeoutMs: { type: 'integer', minimum: 1, maximum: 300000 },
            expectedExitCode: { type: 'integer', minimum: 0, maximum: 255 },
            command: { type: 'object', required: ['executable', 'args'], additionalProperties: false,
              properties: { executable: { ...text(1000), minLength: 1 }, args: { type: 'array', maxItems: 100, items: text(10000) } },
            },
          },
        } },
      },
    } },
  },
});

export function validateIssueSet(value: unknown): asserts value is IssueSet {
  if (!validate(value)) throw new Error(`Issue 数据无效：${validate.errors?.slice(0, 3).map((e) => `${e.instancePath || '/'} ${e.message}`).join('；')}`);
  const ids = new Set<string>();
  for (const issue of (value as IssueSet).issues) {
    if (!issue.title.trim() || ids.has(issue.id)) throw new Error('Issue 标题不能为空且 ID 不得重复');
    ids.add(issue.id);
    const checkIds = new Set<string>();
    for (const check of issue.checks ?? []) {
      if (checkIds.has(check.id)) throw new Error('同一 Issue 的 Check ID 不得重复');
      checkIds.add(check.id);
      if (check.cwd && (/^(?:[\\/]|[A-Za-z]:)/u.test(check.cwd) || check.cwd.split(/[\\/]/u).includes('..'))) {
        throw new Error('Check cwd 必须是副本内的相对路径');
      }
      if ([check.command.executable, ...check.command.args].some((part) => part.includes('\0'))) throw new Error('命令参数不能含 NUL');
    }
  }
}
