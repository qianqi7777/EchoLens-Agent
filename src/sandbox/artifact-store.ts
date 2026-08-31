import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { PathPolicy, validateRelativePath } from '../runtime/path-policy.js';
import type { StructuredPatch } from '../runtime/structured-patch.js';
import {
  SandboxError,
  type SandboxArtifact,
  type SandboxPatchProposal,
} from './types.js';
import type { StagedWorkspace } from './workspace-stager.js';

export interface SandboxArtifactBundle {
  version: 1;
  id: string;
  workspaceRoot: string;
  createdAt: string;
  artifacts: SandboxArtifact[];
  patch?: SandboxPatchProposal;
  warnings: string[];
}

export interface SandboxArtifactCollectionOptions {
  workspaceRoot: string;
  staged: StagedWorkspace;
  id: string;
  requestedPaths?: readonly string[];
  maxChangedFiles?: number;
  maxPatchBytes?: number;
  maxArtifactBytes?: number;
}

// 私有目录（.git/.echolens/node_modules/studydocs）与构建产物不应作为工作区变化回传：前者可能含
// 密钥或权威数据，后者体积大且无业务价值；.env/.env.* 在 isPublicPath 中按任意路径段拒绝。
const PRIVATE_NAMES = new Set(['.git', '.echolens', 'node_modules', 'studydocs']);
const GENERATED_NAMES = new Set(['coverage', 'dist', 'build']);

// 收集容器运行后对暂存工作区的修改：以 stager.prepare 时记录的 baseline 快照为基准，与当前暂存目录
// 比对得到 added/modified/deleted；输出既用于把产物连同 sha256 回传，也生成可审批的安全结构化 Patch。
export async function collectSandboxArtifacts(
  options: SandboxArtifactCollectionOptions,
): Promise<SandboxArtifactBundle> {
  let pendingBundleRoot: string | undefined;
  try {
    const policy = await PathPolicy.create(options.workspaceRoot);
    const id = normalizeBundleId(options.id);
    const bundleRoot = bundleDirectory(policy.workspaceRoot, id);
    pendingBundleRoot = bundleRoot;
    const maxChangedFiles = options.maxChangedFiles ?? 64;
    const maxPatchBytes = options.maxPatchBytes ?? 2 * 1024 * 1024;
    const maxArtifactBytes = options.maxArtifactBytes ?? 16 * 1024 * 1024;
    const baseline = new Map(options.staged.baseline.map((entry) => [entry.path, entry]));
    const currentPaths = await walkFiles(options.staged.root, '.', false);
    const current = new Set(currentPaths);
    const changed = new Set<string>();
    for (const [relative, entry] of baseline) {
      const next = current.has(relative)
        ? await readStagedFile(options.staged.root, relative, maxPatchBytes)
        : undefined;
      if (!next || hash(next) !== hash(entry.bytes)) changed.add(relative);
    }
    for (const relative of current) {
      if (!baseline.has(relative) && isPatchPath(relative)) changed.add(relative);
    }

    const artifacts: SandboxArtifact[] = [];
    const operations: StructuredPatch['operations'] = [];
    const warnings: string[] = [];
    let patchBytes = 0;
    let artifactBytes = 0;
    const sortedChanges = [...changed].sort();
    if (sortedChanges.length > maxChangedFiles) {
      throw new SandboxError(
        'sandbox_artifact_failed',
        `工作区变化 ${sortedChanges.length} 个文件，超过 Artifact 上限 ${maxChangedFiles}`,
      );
    }
    for (const relative of sortedChanges) {
      const before = baseline.get(relative)?.bytes;
      const after = current.has(relative)
        ? await readStagedFile(options.staged.root, relative, maxArtifactBytes)
        : undefined;
      const change = before === undefined ? 'added' : after === undefined ? 'deleted' : 'modified';
      const bytes = after ?? before!;
      artifactBytes += bytes.byteLength;
      if (artifactBytes > maxArtifactBytes) {
        throw new SandboxError('sandbox_artifact_failed', `Artifact 总大小超过 ${maxArtifactBytes} bytes`);
      }
      const storedPath = await persistArtifact(bundleRoot, change === 'deleted' ? `before/${relative}` : `files/${relative}`, bytes);
      artifacts.push({
        path: relative,
        kind: 'workspace-change',
        change,
        mediaType: mediaType(relative, bytes),
        size: bytes.byteLength,
        sha256: `sha256:${hash(bytes)}`,
        storedPath,
      });
      const beforeText = before ? decodeText(before) : undefined;
      const afterText = after ? decodeText(after) : undefined;
      if ((before && beforeText === undefined) || (after && afterText === undefined)) {
        warnings.push(`二进制变化仅作为 Artifact 回传：${relative}`);
        continue;
      }
      patchBytes += (before?.byteLength ?? 0) + (after?.byteLength ?? 0);
      if (patchBytes > maxPatchBytes) {
        warnings.push(`结构化 Patch 内容超过 ${maxPatchBytes} bytes，剩余变化仅作为 Artifact 回传`);
        continue;
      }
      if (change === 'added') operations.push({ op: 'create', path: relative, content: afterText! });
      else if (change === 'deleted') operations.push({ op: 'delete', path: relative, expectedFileHash: `sha256:${hash(before!)}` });
      else operations.push({
        op: 'overwrite',
        path: relative,
        content: afterText!,
        expectedFileHash: `sha256:${hash(before!)}`,
      });
    }

    const requested = normalizeRequestedPaths(options.requestedPaths ?? []);
    for (const relative of requested) {
      if (artifacts.some((item) => item.path === relative)) continue;
      const bytes = await readStagedFile(options.staged.root, relative, maxArtifactBytes);
      artifactBytes += bytes.byteLength;
      if (artifactBytes > maxArtifactBytes) {
        throw new SandboxError('sandbox_artifact_failed', `请求 Artifact 总大小超过 ${maxArtifactBytes} bytes`);
      }
      artifacts.push({
        path: relative,
        kind: 'requested',
        mediaType: mediaType(relative, bytes),
        size: bytes.byteLength,
        sha256: `sha256:${hash(bytes)}`,
        storedPath: await persistArtifact(bundleRoot, `files/${relative}`, bytes),
      });
    }

    const bundle: SandboxArtifactBundle = {
      version: 1,
      id,
      workspaceRoot: policy.workspaceRoot,
      createdAt: new Date().toISOString(),
      artifacts,
      patch: operations.length ? { version: 1, operations } : undefined,
      warnings,
    };
    await mkdir(bundleRoot, { recursive: true });
    await writeFile(path.join(bundleRoot, 'manifest.json'), `${JSON.stringify(bundle)}\n`, { encoding: 'utf8', mode: 0o600 });
    pendingBundleRoot = undefined;
    return bundle;
  } catch (error) {
    // fail-closed：任何一步失败都删除尚未写完成的 bundle 根目录，绝不留下可被加载的部分 bundle。
    if (pendingBundleRoot) await rm(pendingBundleRoot, { recursive: true, force: true }).catch(() => undefined);
    if (error instanceof SandboxError) throw error;
    throw new SandboxError('sandbox_artifact_failed', `Sandbox Artifact 收集失败：${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function loadSandboxArtifactBundle(
  workspaceRoot: string,
  id: string,
): Promise<SandboxArtifactBundle> {
  const policy = await PathPolicy.create(workspaceRoot);
  const normalized = normalizeBundleId(id);
  const manifest = await readFile(path.join(bundleDirectory(policy.workspaceRoot, normalized), 'manifest.json'), 'utf8');
  // 校验版本、ID、workspaceRoot 与当前工作区一致，防止把别的工作区或伪造的 bundle 应用到本工作区。
  const parsed = JSON.parse(manifest) as SandboxArtifactBundle;
  if (parsed.version !== 1 || parsed.id !== normalized || parsed.workspaceRoot !== policy.workspaceRoot) {
    throw new SandboxError('sandbox_artifact_failed', 'Artifact Bundle 不属于当前工作区');
  }
  return parsed;
}

async function walkFiles(root: string, relative: string, includeGenerated: boolean): Promise<string[]> {
  const directory = path.join(root, ...relative.split('/').filter((item) => item !== '.'));
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const child = relative === '.' ? entry.name : `${relative}/${entry.name}`;
    if (!isPublicPath(child) || (!includeGenerated && GENERATED_NAMES.has(entry.name.toLowerCase()))) continue;
    // 符号链接可能指向暂存根之外，stat/readFile 会越过 assertInside 的检查，因此直接拒绝、不跟随。
    if (entry.isSymbolicLink()) throw new SandboxError('sandbox_artifact_failed', `Artifact 拒绝符号链接：${child}`);
    if (entry.isDirectory()) files.push(...await walkFiles(root, child, includeGenerated));
    else if (entry.isFile()) files.push(child);
  }
  return files;
}

async function readStagedFile(root: string, relative: string, limit: number): Promise<Buffer> {
  // relative 来自 baseline 或请求方，不可信。validateRelativePath 拒绝 ../ 与绝对路径，
  // assertInside 再做规范化后的 within-root 校验，防止符号链接拼接或前缀碰撞绕过越界。
  validateRelativePath(relative);
  const target = path.join(root, ...relative.split('/'));
  assertInside(root, target);
  const targetStat = await stat(target);
  if (!targetStat.isFile() || targetStat.size > limit) {
    throw new SandboxError('sandbox_artifact_failed', `Artifact 文件无效或过大：${relative}`);
  }
  return readFile(target);
}

// Bundle 内是真实的文件内容（可能含敏感数据），写入用 0o600 限制为本用户可读；
  // 同时用 assertInside 校验目标落在 bundleRoot 内，避免相对路径把内容写到 bundle 目录之外。
async function persistArtifact(bundleRoot: string, relative: string, bytes: Buffer): Promise<string> {
  const target = path.join(bundleRoot, ...relative.split('/'));
  assertInside(bundleRoot, target);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, bytes, { mode: 0o600 });
  return relative;
}

// requestedPaths 同样来自请求方：去重、(反斜杠→正斜杠、去 ./) 规范化后逐段校验，
  // 任一命中私有目录即拒绝；数量上限防止请求方枚举海量路径。
function normalizeRequestedPaths(values: readonly string[]): string[] {
  if (values.length > 32) throw new SandboxError('sandbox_invalid_request', 'Artifact 路径不能超过 32 个');
  return [...new Set(values.map((value) => {
    validateRelativePath(value);
    const normalized = value.replaceAll('\\', '/').replace(/^\.\//u, '');
    if (!isPublicPath(normalized)) throw new SandboxError('sandbox_artifact_failed', `Artifact 路径属于私有目录：${normalized}`);
    return normalized;
  }))].sort();
}

function isPatchPath(relative: string): boolean {
  return isPublicPath(relative) && !relative.split('/').some((item) => GENERATED_NAMES.has(item.toLowerCase()));
}

function isPublicPath(relative: string): boolean {
  return !relative.split('/').some((item) => {
    const lower = item.toLowerCase();
    return PRIVATE_NAMES.has(lower) || lower === '.env' || lower.startsWith('.env.');
  });
}

function normalizeBundleId(id: string): string {
  const normalized = id.replace(/^echolens-/u, '');
  if (!/^[a-f0-9-]{36}$/u.test(normalized)) throw new SandboxError('sandbox_artifact_failed', 'Artifact Bundle ID 无效');
  return normalized;
}

function bundleDirectory(workspaceRoot: string, id: string): string {
  const root = path.join(workspaceRoot, '.echolens', 'artifacts');
  const target = path.join(root, id);
  assertInside(root, target);
  return target;
}

function decodeText(bytes: Buffer): string | undefined {
  // 用 strict/fatal 解码 UTF-8 判定文本（去掉可选 BOM）；解码失败视为二进制，仅作为 Artifact 回传，
  // 不进入结构化 Patch，避免把损坏的多字节序列写回工作区。
  const bom = bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]));
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bom ? bytes.subarray(3) : bytes); }
  catch { return undefined; }
}

function mediaType(relative: string, bytes: Buffer): string {
  if (decodeText(bytes) !== undefined) return 'text/plain; charset=utf-8';
  const extension = path.extname(relative).toLowerCase();
  if (extension === '.png') return 'image/png';
  if (extension === '.jpg' || extension === '.jpeg') return 'image/jpeg';
  if (extension === '.json') return 'application/json';
  return 'application/octet-stream';
}

function hash(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function assertInside(root: string, candidate: string): void {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new SandboxError('sandbox_artifact_failed', 'Artifact 路径越界');
  }
}
