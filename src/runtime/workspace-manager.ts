import { homedir } from 'node:os';
import { realpath, stat } from 'node:fs/promises';
import * as path from 'node:path';

export interface WorkspaceDescriptor {
  workspaceRoot: string;
  sessionId: string;
}

export interface ManagedWorkspaceRuntime extends WorkspaceDescriptor {
  close(): Promise<void>;
}

export interface WorkspaceSwitchResult extends WorkspaceDescriptor {
  changed: boolean;
  notices: string[];
  warnings: string[];
}

export interface WorkspaceCommandService {
  current(): WorkspaceDescriptor;
  switchWorkspace(requestedPath: string): Promise<WorkspaceSwitchResult>;
}

export interface WorkspaceCommandResult {
  handled: boolean;
  lines: string[];
  workspace?: WorkspaceSwitchResult;
}

export type WorkspaceRuntimeFactory<T extends ManagedWorkspaceRuntime> = (
  workspaceRoot: string,
) => Promise<T>;

export class WorkspaceSwitchError extends Error {
  constructor(
    readonly code:
      | 'workspace_path_required'
      | 'workspace_not_found'
      | 'workspace_not_directory'
      | 'workspace_open_failed',
    message: string,
  ) {
    super(message);
    this.name = 'WorkspaceSwitchError';
  }
}

/**
 * 管理与工作区绑定的运行时资源。
 *
 * 切换时先创建完整的新运行时；创建成功后才替换 current 并关闭旧运行时。
 * 新工作区初始化失败不会破坏仍可使用的旧 Session、工具和扩展。
 */
export class WorkspaceRuntimeManager<T extends ManagedWorkspaceRuntime> implements WorkspaceCommandService {
  private active?: T;
  private transitionQueue: Promise<unknown> = Promise.resolve();

  constructor(
    initialRuntime: T,
    private readonly factory: WorkspaceRuntimeFactory<T>,
  ) {
    this.active = initialRuntime;
  }

  currentRuntime(): T {
    if (!this.active) throw new WorkspaceSwitchError('workspace_open_failed', '工作区运行时已关闭');
    return this.active;
  }

  current(): WorkspaceDescriptor {
    const current = this.currentRuntime();
    return { workspaceRoot: current.workspaceRoot, sessionId: current.sessionId };
  }

  switchWorkspace(requestedPath: string): Promise<WorkspaceSwitchResult> {
    const operation = this.transitionQueue.then(() => this.switchWorkspaceInternal(requestedPath));
    this.transitionQueue = operation.catch(() => undefined);
    return operation;
  }

  async close(): Promise<void> {
    await this.transitionQueue;
    const current = this.active;
    this.active = undefined;
    await current?.close();
  }

  private async switchWorkspaceInternal(requestedPath: string): Promise<WorkspaceSwitchResult> {
    const previous = this.currentRuntime();
    const workspaceRoot = await resolveWorkspaceDirectory(requestedPath, previous.workspaceRoot);
    if (samePath(workspaceRoot, previous.workspaceRoot)) {
      return { ...this.current(), changed: false, notices: [], warnings: [] };
    }

    let next: T;
    try {
      next = await this.factory(workspaceRoot);
    } catch (error) {
      if (error instanceof WorkspaceSwitchError) throw error;
      throw new WorkspaceSwitchError(
        'workspace_open_failed',
        `无法初始化工作区：${safeMessage(error)}`,
      );
    }
    if (!samePath(next.workspaceRoot, workspaceRoot)) {
      await next.close().catch(() => undefined);
      throw new WorkspaceSwitchError('workspace_open_failed', '新运行时返回了不一致的工作区路径');
    }

    this.active = next;
    const warnings: string[] = [];
    try {
      await previous.close();
    } catch (error) {
      warnings.push(`旧工作区资源清理失败：${safeMessage(error)}`);
    }
    return {
      workspaceRoot: next.workspaceRoot,
      sessionId: next.sessionId,
      changed: true,
      notices: [],
      warnings,
    };
  }
}

export function isWorkspaceCommand(input: string): boolean {
  const normalized = input.trim();
  return normalized === '/pwd'
    || normalized === '/workspace'
    || normalized === '/cd'
    || normalized.startsWith('/workspace ')
    || normalized.startsWith('/cd ');
}

export async function executeWorkspaceCommand(
  input: string,
  service: WorkspaceCommandService,
): Promise<WorkspaceCommandResult> {
  if (!isWorkspaceCommand(input)) return { handled: false, lines: [] };
  const normalized = input.trim();
  if (normalized === '/pwd' || normalized === '/workspace') {
    const current = service.current();
    return {
      handled: true,
      lines: [`工作目录：${current.workspaceRoot}`, `Session：${current.sessionId}`],
    };
  }
  if (normalized === '/cd') {
    return { handled: true, lines: ['用法：/cd <path> 或 /workspace <path>'] };
  }

  const separator = normalized.indexOf(' ');
  const requestedPath = stripMatchingQuotes(normalized.slice(separator + 1).trim());
  if (!requestedPath) {
    return { handled: true, lines: ['用法：/cd <path> 或 /workspace <path>'] };
  }
  const workspace = await service.switchWorkspace(requestedPath);
  return {
    handled: true,
    workspace,
    lines: [
      workspace.changed ? `工作目录已切换：${workspace.workspaceRoot}` : `工作目录未变化：${workspace.workspaceRoot}`,
      `Session：${workspace.sessionId}`,
      ...workspace.notices,
      ...workspace.warnings.map((warning) => `警告：${warning}`),
    ],
  };
}

export async function resolveWorkspaceDirectory(
  requestedPath: string,
  baseDirectory: string,
): Promise<string> {
  const normalized = stripMatchingQuotes(requestedPath.trim());
  if (!normalized) throw new WorkspaceSwitchError('workspace_path_required', '工作目录不能为空');
  const expanded = expandHome(normalized);
  const candidate = path.resolve(baseDirectory, expanded);
  let canonical: string;
  try {
    canonical = await realpath(candidate);
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) {
      throw new WorkspaceSwitchError('workspace_not_found', `工作目录不存在：${candidate}`);
    }
    throw new WorkspaceSwitchError('workspace_open_failed', `无法访问工作目录：${safeMessage(error)}`);
  }
  let info;
  try {
    info = await stat(canonical);
  } catch (error) {
    throw new WorkspaceSwitchError('workspace_open_failed', `无法检查工作目录：${safeMessage(error)}`);
  }
  if (!info.isDirectory()) {
    throw new WorkspaceSwitchError('workspace_not_directory', `目标不是目录：${canonical}`);
  }
  return canonical;
}

function stripMatchingQuotes(value: string): string {
  if (value.length < 2) return value;
  const first = value[0];
  const last = value.at(-1);
  return (first === '"' && last === '"') || (first === "'" && last === "'")
    ? value.slice(1, -1).trim()
    : value;
}

function expandHome(value: string): string {
  if (value === '~') return homedir();
  if (value.startsWith('~/') || value.startsWith('~\\')) {
    return path.join(homedir(), value.slice(2));
  }
  return value;
}

function samePath(left: string, right: string): boolean {
  const normalizedLeft = path.resolve(left);
  const normalizedRight = path.resolve(right);
  return process.platform === 'win32'
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === code;
}

function safeMessage(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500);
}
