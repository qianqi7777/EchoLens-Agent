import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { textMessage, type ConversationItem, type ToolResultItem } from '../../../../src/core/messages.js';
import { systemPolicyMessage } from '../../../../src/core/system-policy.js';
import { ContextManager } from '../../../../src/context/context-manager.js';
import { InstructionLoader } from '../../../../src/context/instruction-loader.js';
import { SkillLoader } from '../../../../src/skills/loader.js';

test('/context 报告按最终注入 item 归因，来源占用与实际内容一致', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'echolens-context-report-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'AGENTS.md'), '仅做只读分析');
  const skillRoot = join(root, '.echolens', 'skills', 'review');
  await mkdir(skillRoot, { recursive: true });
  await writeFile(join(skillRoot, 'SKILL.md'), '---\nname: review\ndescription: review source changes when investigating a code change\n---\nReview carefully.\n');
  const skillLoader = new SkillLoader({ workspaceRoot: root, userSkillRoot: join(root, 'missing-user'), builtinSkillRoot: join(root, 'missing-builtin') });
  const manager = new ContextManager({
    workspaceRoot: root,
    instructionLoader: new InstructionLoader({ workspaceRoot: root, userInstructionDirectory: join(root, 'missing-global') }),
    skillLoader,
  });
  const toolResult: ToolResultItem = {
    type: 'tool_result', id: 'tool-result', callId: 'call-1', toolName: 'read_file', status: 'ok',
    output: { id: 'output', kind: 'tool_output', content: 'file content', source: { type: 'tool', toolName: 'read_file' }, trust: 'untrusted', redactions: [] },
    summary: '读取文件', evidenceIds: [],
  };
  const items: ConversationItem[] = [
    systemPolicyMessage(),
    textMessage('user-1', 'user', 'review source'),
    toolResult,
  ];
  const built = await manager.build(items, {
    privacy: 'full-context', providerMaxContextTokens: 8_192, runtimePermissions: new Set(),
    navigationHint: { mode: 'direct', confidence: 0.9, matches: [], candidatePaths: ['src/index.ts'], symbols: [], searchHints: [], recommendedActions: [] },
  });
  const ids = new Set(built.items.map((item) => item.id));
  const reportedIds = built.sourceUsage.flatMap((item) => item.itemIds);
  assert.equal(new Set(reportedIds).size, built.items.length);
  assert.ok(reportedIds.every((id) => ids.has(id)));
  assert.deepEqual(built.sourceUsage.map((item) => item.source), ['system-policy', 'rules', 'skill-catalog', 'conversation', 'tool-output', 'index-hints']);
  assert.equal(built.sourceUsage.find((item) => item.source === 'tool-output')?.itemCount, 1);
  assert.ok(built.sourceUsage.every((item) => item.estimatedTokens > 0));
  assert.equal(manager.report()?.estimatedTokens, built.estimatedTokens);
  const report = manager.report()!;
  const reportFirst = report.items[0];
  assert.equal(reportFirst?.type, 'message');
  if (reportFirst?.type === 'message') reportFirst.content[0]!.text = 'mutated copy';
  const freshFirst = manager.report()?.items[0];
  assert.equal(freshFirst?.type, 'message');
  assert.notEqual(freshFirst.type === 'message' ? freshFirst.content[0]?.text : undefined, 'mutated copy');
});
