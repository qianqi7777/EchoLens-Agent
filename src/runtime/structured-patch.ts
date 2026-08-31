import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import {
  captureWorkspaceSnapshot,
  type WorkspaceRevision,
  type WorkspaceSnapshot,
} from './workspace-snapshot.js';
import { PathPolicy, PathPolicyError, validateRelativePath } from './path-policy.js';

export type PatchOperation =
  | ReplacePatchOperation
  | OverwritePatchOperation
  | CreatePatchOperation
  | DeletePatchOperation;

export interface ReplacePatchOperation {
  op: 'replace';
  path: string;
  oldString: string;
  newString: string;
  expectedFileHash?: string;
  expectedContext?: { before?: string; after?: string };
}

export interface OverwritePatchOperation {
  op: 'overwrite';
  path: string;
  content: string;
  expectedFileHash: string;
}

export interface CreatePatchOperation {
  op: 'create';
  path: string;
  content: string;
  expectedFileHash?: never;
}

export interface DeletePatchOperation {
  op: 'delete';
  path: string;
  expectedFileHash: string;
}

export interface StructuredPatch {
  version: 1;
  operations: PatchOperation[];
}

export interface PatchFilePreview {
  path: string;
  operation: PatchOperation['op'];
  beforeHash?: string;
  afterHash?: string;
  beforeBytes: number;
  afterBytes: number;
  linesAdded: number;
  linesRemoved: number;
  diff: string;
}

export interface PatchPreview {
  patch: StructuredPatch;
  workspaceRevision: WorkspaceRevision;
  files: PatchFilePreview[];
  changedFiles: string[];
  totalAddedLines: number;
  totalRemovedLines: number;
  totalBytes: number;
}

export interface EditCheckpoint {
  version: 1;
  workspaceRoot: string;
  workspaceRevision: WorkspaceRevision;
  createdAt: string;
  files: Array<{ path: string; contentBase64?: string; existed: boolean; hash?: string; afterHash?: string }>;
}

export interface ApplyPatchResult {
  preview: PatchPreview;
  checkpoint: EditCheckpoint;
  afterSnapshot: WorkspaceSnapshot;
}

export class PatchError extends Error {
  constructor(
    readonly code:
      | 'patch_invalid'
      | 'patch_context_mismatch'
      | 'patch_ambiguous'
      | 'patch_hash_mismatch'
      | 'patch_target_exists'
      | 'patch_binary_unsupported'
      | 'patch_limits_exceeded'
      | 'patch_workspace_changed'
      | 'patch_apply_failed'
      | 'patch_rollback_failed',
    message: string,
    readonly path?: string,
  ) {
    super(message);
    this.name = 'PatchError';
  }
}

export interface StructuredPatchOptions {
  maxOperations?: number;
  maxFiles?: number;
  maxChangedBytes?: number;
  maxChangedLines?: number;
}

export async function saveEditCheckpoint(workspaceRoot: string, checkpoint: EditCheckpoint): Promise<string> {
  // 检查点包含工作区文件原文（base64），属用户敏感数据，落盘用 0o600 限制其它进程读取。
  // ID 取内容哈希前 24 位，读入时按相同格式校验，避免外部指定任意文件名。
  const id = createHash('sha256').update(JSON.stringify(checkpoint)).digest('hex').slice(0, 24);
  const directory = path.join(workspaceRoot, '.echolens', 'checkpoints');
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, `${id}.json`), `${JSON.stringify(checkpoint)}\n`, { encoding: 'utf8', mode: 0o600 });
  return id;
}

export async function loadEditCheckpoint(workspaceRoot: string, id: string): Promise<EditCheckpoint> {
  // 先校验 ID 为 24 位十六进制，避免把构造出的路径直接当作文件名读取（路径穿越）。
  // 再校验 version 与 workspaceRoot，确保检查点属于当前工作区，防止恢复其它工作区的状态。
  if (!/^[a-f0-9]{24}$/u.test(id)) throw new PatchError('patch_invalid', 'Checkpoint ID 无效');
  const value = JSON.parse(await readFile(path.join(workspaceRoot, '.echolens', 'checkpoints', `${id}.json`), 'utf8')) as EditCheckpoint;
  if (value.version !== 1 || value.workspaceRoot !== (await PathPolicy.create(workspaceRoot)).workspaceRoot) {
    throw new PatchError('patch_invalid', 'Checkpoint 不属于当前工作区');
  }
  return value;
}

// 安全上限：约束单个补丁的操作数、文件数、改动字节与改动行，防止异常或恶意的
// 超大补丁消耗过多内存、刷屏审批 UI，也便于审批者理解改动规模。
const DEFAULT_LIMITS = {
  maxOperations: 64,
  maxFiles: 64,
  maxChangedBytes: 2 * 1024 * 1024,
  maxChangedLines: 20_000,
} as const;

export function normalizePatch(value: unknown, options: StructuredPatchOptions = {}): StructuredPatch {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.operations)) {
    throw new PatchError('patch_invalid', 'Patch 必须是 version=1 的结构化对象');
  }
  const limits = { ...DEFAULT_LIMITS, ...options };
  if (value.operations.length === 0 || value.operations.length > limits.maxOperations) {
    throw new PatchError('patch_limits_exceeded', `Patch 操作数必须在 1-${limits.maxOperations} 之间`);
  }
  const paths = new Set<string>();
  const operations = value.operations.map((candidate) => {
    if (!isRecord(candidate) || typeof candidate.op !== 'string' || typeof candidate.path !== 'string') {
      throw new PatchError('patch_invalid', 'Patch 操作缺少 op 或 path');
    }
    // 统一为 POSIX 相对路径后再判重：`.`（即根目录）与重复路径都会让补丁产生歧义，直接拒绝。
    validateRelativePath(candidate.path);
    const normalizedPath = candidate.path.replaceAll('\\', '/').replace(/^\.\//u, '') || '.';
    if (normalizedPath === '.' || paths.has(normalizedPath)) {
      throw new PatchError('patch_invalid', `Patch 路径重复或无效：${normalizedPath}`, normalizedPath);
    }
    paths.add(normalizedPath);
    if (candidate.op === 'replace') {
      if (typeof candidate.oldString !== 'string' || typeof candidate.newString !== 'string') {
        throw new PatchError('patch_invalid', `replace 缺少 oldString/newString：${normalizedPath}`, normalizedPath);
      }
      return {
        op: 'replace',
        path: normalizedPath,
        oldString: candidate.oldString,
        newString: candidate.newString,
        expectedFileHash: optionalString(candidate.expectedFileHash),
        expectedContext: normalizeContext(candidate.expectedContext),
      } satisfies ReplacePatchOperation;
    }
    if (candidate.op === 'overwrite') {
      const expectedFileHash = optionalString(candidate.expectedFileHash);
      if (typeof candidate.content !== 'string' || !expectedFileHash) {
        throw new PatchError('patch_invalid', `overwrite 必须提供 content 和 expectedFileHash：${normalizedPath}`, normalizedPath);
      }
      return {
        op: 'overwrite',
        path: normalizedPath,
        content: candidate.content,
        expectedFileHash,
      } satisfies OverwritePatchOperation;
    }
    if (candidate.op === 'create') {
      if (typeof candidate.content !== 'string') {
        throw new PatchError('patch_invalid', `create 缺少 content：${normalizedPath}`, normalizedPath);
      }
      return { op: 'create', path: normalizedPath, content: candidate.content } satisfies CreatePatchOperation;
    }
    if (candidate.op === 'delete') {
      const expectedFileHash = optionalString(candidate.expectedFileHash);
      if (!expectedFileHash) throw new PatchError('patch_invalid', `delete 必须提供 expectedFileHash：${normalizedPath}`, normalizedPath);
      return { op: 'delete', path: normalizedPath, expectedFileHash } satisfies DeletePatchOperation;
    }
    throw new PatchError('patch_invalid', `不支持的 Patch 操作：${candidate.op}`, normalizedPath);
  });
  if (operations.length > limits.maxFiles) throw new PatchError('patch_limits_exceeded', `Patch 文件数超过 ${limits.maxFiles}`);
  return { version: 1, operations };
}

/**
 * 计算补丁预览，不修改工作区。
 *
 * 预览可安全反复调用：只读，同一路径按顺序在内存中叠加操作，绝不落盘。
 * @throws 补丁非法、操作数/文件数/改动规模超上限、oldString 不唯一、文件哈希或上下文不匹配时抛 PatchError。
 */
export async function previewPatch(
  workspaceRoot: string,
  patchInput: unknown,
  options: StructuredPatchOptions = {},
): Promise<PatchPreview> {
  const patch = normalizePatch(patchInput, options);
  const policy = await PathPolicy.create(workspaceRoot);
  const snapshot = await captureWorkspaceSnapshot(workspaceRoot);
  // 预览阶段只读：操作按顺序应用到内存缓冲（states），同一路径在补丁内的后续操作
  // 能看到此前操作的中间结果，但绝不落盘，避免在审批前改动工作区。
  const states = new Map<string, Buffer>();
  const previews: PatchFilePreview[] = [];
  for (const operation of patch.operations) {
    const current = states.get(operation.path) ?? await readCurrent(policy, operation.path, operation.op);
    if (operation.op === 'create') {
      if (current !== undefined) throw new PatchError('patch_target_exists', `create 目标已存在：${operation.path}`, operation.path);
      const next = encodeText(operation.content, false, 'LF');
      previews.push(filePreview(operation, undefined, next));
      states.set(operation.path, next);
      continue;
    }
    const decoded = decodeText(current!, operation.path);
    const expected = operation.expectedFileHash;
    if (expected && expected !== hashBytes(current!)) {
      throw new PatchError('patch_hash_mismatch', `文件哈希已变化：${operation.path}`, operation.path);
    }
    if (operation.op === 'delete') {
      if (expected !== hashBytes(current!)) throw new PatchError('patch_hash_mismatch', `删除文件哈希不匹配：${operation.path}`, operation.path);
      previews.push(filePreview(operation, current!, undefined));
      states.set(operation.path, Buffer.alloc(0));
      continue;
    }
    if (operation.op === 'overwrite') {
      // 按原文件的 BOM 与换行风格重写，避免一次文本改写悄悄抹掉 CRLF 或 BOM。
      const next = encodeText(operation.content, decoded.bom, decoded.newline);
      previews.push(filePreview(operation, current!, next));
      states.set(operation.path, next);
      continue;
    }
    const oldLogical = logicalNewlines(operation.oldString);
    const contentLogical = logicalNewlines(decoded.text);
    // oldString 必须唯一匹配：0 次说明上下文已漂移，多次说明无法判断替换位置，两者都拒绝。
    const matches = countMatches(contentLogical, oldLogical);
    if (matches === 0) throw new PatchError('patch_context_mismatch', `未找到唯一 oldString：${operation.path}`, operation.path);
    if (matches > 1) throw new PatchError('patch_ambiguous', `oldString 匹配 ${matches} 次：${operation.path}`, operation.path);
    const index = contentLogical.indexOf(oldLogical);
    checkContext(contentLogical, index, oldLogical.length, operation.expectedContext, operation.path);
    const replaced = contentLogical.slice(0, index) + logicalNewlines(operation.newString) + contentLogical.slice(index + oldLogical.length);
    const next = encodeText(replaced, decoded.bom, decoded.newline);
    previews.push(filePreview(operation, current!, next));
    states.set(operation.path, next);
  }
  const totalAddedLines = previews.reduce((sum, item) => sum + item.linesAdded, 0);
  const totalRemovedLines = previews.reduce((sum, item) => sum + item.linesRemoved, 0);
  const totalBytes = previews.reduce((sum, item) => sum + Math.abs(item.afterBytes - item.beforeBytes), 0);
  if (totalAddedLines + totalRemovedLines > (options.maxChangedLines ?? DEFAULT_LIMITS.maxChangedLines)
    || totalBytes > (options.maxChangedBytes ?? DEFAULT_LIMITS.maxChangedBytes)) {
    throw new PatchError('patch_limits_exceeded', 'Patch 修改规模超过安全上限');
  }
  return {
    patch,
    workspaceRevision: snapshot.revision,
    files: previews,
    changedFiles: previews.map((item) => item.path),
    totalAddedLines,
    totalRemovedLines,
    totalBytes,
  };
}

/**
 * 应用结构化补丁到工作区，任一文件写入失败时整体回滚。
 *
 * 应用前再次校验工作区 revision，确保预览/审批后工作区未被外部改动。
 * @throws PatchError；回滚本身失败时抛 `patch_rollback_failed`，需人工介入确认工作区状态。
 */
export async function applyPatch(
  workspaceRoot: string,
  patchInput: unknown,
  options: StructuredPatchOptions = {},
): Promise<ApplyPatchResult> {
  const preview = await previewPatch(workspaceRoot, patchInput, options);
  const policy = await PathPolicy.create(workspaceRoot);
  const currentSnapshot = await captureWorkspaceSnapshot(workspaceRoot);
  // 预览/审批与应用之间可能隔了用户操作，revision 不一致则拒绝应用，避免覆盖用户刚做的改动。
  if (currentSnapshot.revision.value !== preview.workspaceRevision.value) {
    throw new PatchError('patch_workspace_changed', '工作区在审批或预览后发生变化');
  }
  const checkpointFiles: EditCheckpoint['files'] = [];
  for (const item of preview.files) {
    if (item.operation === 'create') checkpointFiles.push({ path: item.path, existed: false, afterHash: item.afterHash });
    else {
      const current = await policy.readFileBytes(item.path);
      checkpointFiles.push({ path: item.path, existed: true, contentBase64: current.bytes.toString('base64'), hash: hashBytes(current.bytes), afterHash: item.afterHash });
    }
  }
  const checkpoint: EditCheckpoint = {
    version: 1,
    workspaceRoot: policy.workspaceRoot,
    workspaceRevision: preview.workspaceRevision,
    createdAt: new Date().toISOString(),
    files: checkpointFiles,
  };
  try {
    for (const item of preview.files) {
      const operation = preview.patch.operations.find((candidate) => candidate.path === item.path)!;
      const next = await materializeOperation(policy, operation, item.beforeHash);
      if (operation.op === 'create') {
        const created = await policy.createFile(operation.path);
        try { await created.handle.writeFile(next!); } finally { await created.handle.close(); }
      } else if (operation.op === 'delete') {
        await policy.deleteFile(operation.path);
      } else {
        const handle = await policy.openFileForWrite(operation.path);
        try { await handle.handle.writeFile(next!); await handle.handle.truncate(next!.byteLength); } finally { await handle.handle.close(); }
      }
    }
  } catch (error) {
    // 任一文件写入失败立即整体回滚；回滚本身失败才抛 patch_rollback_failed，交由调用方人工处理。
    try { await rollbackCheckpoint(checkpoint); }
    catch (rollbackError) { throw new PatchError('patch_rollback_failed', `Patch 失败且回滚失败：${String(rollbackError)}`); }
    if (error instanceof PatchError) throw error;
    throw new PatchError('patch_apply_failed', 'Patch 写入失败，已回滚');
  }
  const afterSnapshot = await captureWorkspaceSnapshot(workspaceRoot);
  return { preview, checkpoint, afterSnapshot };
}

export async function rollbackCheckpoint(checkpoint: EditCheckpoint): Promise<{ restoredPaths: string[]; skippedPaths: string[] }> {
  const policy = await PathPolicy.create(checkpoint.workspaceRoot);
  const restoredPaths: string[] = [];
  const skippedPaths: string[] = [];
  try {
    // 回滚只恢复到「本补丁应用前」的状态：仅当文件当前哈希等于应用后哈希时才改动它。
    // 若用户在应用后又改了该文件，说明现状不是本补丁造成的，跳过以免覆盖用户新改动。
    for (const file of checkpoint.files) {
      if (!file.existed) {
        const current = await policy.readFileBytes(file.path).catch((error) => {
          if (error instanceof PathPolicyError && error.code === 'path_not_found') return undefined;
          throw error;
        });
        if (!current) continue;
        if (file.afterHash && hashBytes(current.bytes) !== file.afterHash) { skippedPaths.push(file.path); continue; }
        await policy.deleteFile(file.path);
        restoredPaths.push(file.path);
        continue;
      }
      const bytes = Buffer.from(file.contentBase64 ?? '', 'base64');
      const current = await policy.readFileBytes(file.path).catch((error) => {
        if (error instanceof PathPolicyError && error.code === 'path_not_found') return undefined;
        throw error;
      });
      if (current && file.afterHash && hashBytes(current.bytes) !== file.afterHash) { skippedPaths.push(file.path); continue; }
      if (!current && file.afterHash && file.afterHash !== undefined) {
        skippedPaths.push(file.path);
        continue;
      }
      const handle = await openOrCreate(policy, file.path);
      try { await handle.handle.writeFile(bytes); await handle.handle.truncate(bytes.byteLength); }
      finally { await handle.handle.close(); }
      restoredPaths.push(file.path);
    }
    return { restoredPaths, skippedPaths };
  } catch (error) {
    throw new PatchError('patch_rollback_failed', `无法回滚文件：${error instanceof Error ? error.message : String(error)}`);
  }
}

async function openOrCreate(policy: PathPolicy, relativePath: string): Promise<{ handle: import('node:fs/promises').FileHandle; canonicalPath: string }> {
  try { return await policy.openFileForWrite(relativePath); }
  catch (error) {
    if (!(error instanceof PathPolicyError) || error.code !== 'path_not_found') throw error;
    return policy.createFile(relativePath);
  }
}

function filePreview(operation: PatchOperation, before: Buffer | undefined, after: Buffer | undefined): PatchFilePreview {
  const beforeText = before ? safeText(before) : '';
  const afterText = after ? safeText(after) : '';
  const oldLines = beforeText.split(/\r?\n/u);
  const newLines = afterText.split(/\r?\n/u);
  const linesRemoved = before ? diffLineCount(oldLines, newLines, true) : 0;
  const linesAdded = after ? diffLineCount(oldLines, newLines, false) : 0;
  return {
    path: operation.path,
    operation: operation.op,
    beforeHash: before ? hashBytes(before) : undefined,
    afterHash: after ? hashBytes(after) : undefined,
    beforeBytes: before?.byteLength ?? 0,
    afterBytes: after?.byteLength ?? 0,
    linesAdded,
    linesRemoved,
    diff: renderDiff(operation.path, beforeText, afterText),
  };
}

async function readCurrent(policy: PathPolicy, relativePath: string, operation: PatchOperation['op']): Promise<Buffer | undefined> {
  try { return (await policy.readFileBytes(relativePath)).bytes; }
  catch (error) {
    if (operation === 'create' && error instanceof PathPolicyError && error.code === 'path_not_found') return undefined;
    if (operation === 'create') throw new PatchError('patch_target_exists', `create 目标状态异常：${relativePath}`, relativePath);
    throw new PatchError('patch_context_mismatch', `无法读取目标文件：${relativePath}`, relativePath);
  }
}

// 探测 BOM 与换行风格；UTF-8 用 fatal 解码，非 UTF-8 或二进制直接拒绝
// （patch_binary_unsupported），避免把二进制/乱码当作文本改写破坏文件。
function decodeText(bytes: Buffer, relativePath: string): { text: string; bom: boolean; newline: 'CRLF' | 'LF' } {
  const bom = bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]));
  const body = bom ? bytes.subarray(3) : bytes;
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(body); }
  catch { throw new PatchError('patch_binary_unsupported', `只支持 UTF-8 文本：${relativePath}`, relativePath); }
  return { text, bom, newline: text.includes('\r\n') ? 'CRLF' : 'LF' };
}

function encodeText(text: string, bom: boolean, newline: 'CRLF' | 'LF'): Buffer {
  const normalized = logicalNewlines(text);
  const output = newline === 'CRLF' ? normalized.replaceAll('\n', '\r\n') : normalized;
  const body = Buffer.from(output, 'utf8');
  return bom ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), body]) : body;
}

// 把 CRLF（及单独 CR）统一为 LF：oldString 可能用 LF 而文件是 CRLF，直接替换会漏匹配；
// 因此匹配与替换都在 LF 化后的文本上完成，落盘时再按原换行风格还原。
function logicalNewlines(value: string): string { return value.replaceAll('\r\n', '\n').replaceAll('\r', '\n'); }

function countMatches(value: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let index = 0;
  while ((index = value.indexOf(needle, index)) >= 0) { count += 1; index += needle.length; }
  return count;
}

function checkContext(content: string, index: number, length: number, context: ReplacePatchOperation['expectedContext'], relativePath: string): void {
  if (!context) return;
  if (context.before !== undefined && !content.slice(0, index).endsWith(logicalNewlines(context.before))) {
    throw new PatchError('patch_context_mismatch', `前置上下文不匹配：${relativePath}`, relativePath);
  }
  if (context.after !== undefined && !content.slice(index + length).startsWith(logicalNewlines(context.after))) {
    throw new PatchError('patch_context_mismatch', `后置上下文不匹配：${relativePath}`, relativePath);
  }
}

function renderDiff(relativePath: string, before: string, after: string): string {
  const oldLines = before.split(/\r?\n/u);
  const newLines = after.split(/\r?\n/u);
  const lines = [`--- ${relativePath}`, `+++ ${relativePath}`];
  const length = Math.max(oldLines.length, newLines.length);
  for (let index = 0; index < length; index += 1) {
    const oldLine = oldLines[index];
    const newLine = newLines[index];
    if (oldLine === newLine) { if (oldLine !== undefined) lines.push(` ${oldLine}`); }
    else {
      if (oldLine !== undefined) lines.push(`-${oldLine}`);
      if (newLine !== undefined) lines.push(`+${newLine}`);
    }
  }
  return lines.join('\n');
}

function diffLineCount(oldLines: string[], newLines: string[], removed: boolean): number {
  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < oldLines.length - prefix && suffix < newLines.length - prefix
    && oldLines[oldLines.length - suffix - 1] === newLines[newLines.length - suffix - 1]) suffix += 1;
  return removed
    ? Math.max(0, oldLines.length - prefix - suffix)
    : Math.max(0, newLines.length - prefix - suffix);
}

// 应用阶段基于当前实际文件重算目标内容并再次校验哈希，与预览一致才落盘；
// 若期间文件被外部改动，则抛 patch_workspace_changed 阻止覆盖。
async function materializeOperation(policy: PathPolicy, operation: PatchOperation, expectedBeforeHash?: string): Promise<Buffer | undefined> {
  if (operation.op === 'create') return encodeText(operation.content, false, 'LF');
  const current = (await policy.readFileBytes(operation.path)).bytes;
  if (expectedBeforeHash && expectedBeforeHash !== hashBytes(current)) {
    throw new PatchError('patch_workspace_changed', `文件在应用期间发生变化：${operation.path}`, operation.path);
  }
  if (operation.op === 'delete' && operation.expectedFileHash !== hashBytes(current)) {
    throw new PatchError('patch_workspace_changed', `删除文件在应用期间发生变化：${operation.path}`, operation.path);
  }
  if (operation.op === 'delete') return undefined;
  const decoded = decodeText(current, operation.path);
  if (operation.expectedFileHash && operation.expectedFileHash !== hashBytes(current)) {
    throw new PatchError('patch_workspace_changed', `文件在应用前发生变化：${operation.path}`, operation.path);
  }
  if (operation.op === 'overwrite') return encodeText(operation.content, decoded.bom, decoded.newline);
  const oldLogical = logicalNewlines(operation.oldString);
  const contentLogical = logicalNewlines(decoded.text);
  const matches = countMatches(contentLogical, oldLogical);
  if (matches !== 1) throw new PatchError(matches === 0 ? 'patch_context_mismatch' : 'patch_ambiguous', `Patch 上下文已变化：${operation.path}`, operation.path);
  const index = contentLogical.indexOf(oldLogical);
  checkContext(contentLogical, index, oldLogical.length, operation.expectedContext, operation.path);
  const replaced = contentLogical.slice(0, index) + logicalNewlines(operation.newString) + contentLogical.slice(index + oldLogical.length);
  return encodeText(replaced, decoded.bom, decoded.newline);
}

function safeText(value: Buffer): string {
  const decoded = decodeText(value, 'preview');
  return decoded.text;
}

function hashBytes(value: Buffer): string { return `sha256:${createHash('sha256').update(value).digest('hex')}`; }
function optionalString(value: unknown): string | undefined { return typeof value === 'string' && value.trim() ? value : undefined; }
function normalizeContext(value: unknown): ReplacePatchOperation['expectedContext'] | undefined {
  if (!isRecord(value)) return undefined;
  const before = typeof value.before === 'string' ? value.before : undefined;
  const after = typeof value.after === 'string' ? value.after : undefined;
  return before === undefined && after === undefined ? undefined : { before, after };
}
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
