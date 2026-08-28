import {
  previewPatch,
  previewSandboxPatch,
  type ApprovalRequest,
} from './runtime/index.js';

export interface ApprovalPreview {
  changedFiles: string[];
  diff: string;
}

export async function previewApprovalRequest(request: ApprovalRequest): Promise<ApprovalPreview | undefined> {
  if (request.toolName === 'apply_patch') {
    const patch = (request.arguments as { patch?: unknown }).patch;
    const preview = await previewPatch(request.workspaceRoot, patch);
    return {
      changedFiles: preview.changedFiles,
      diff: preview.files.map((file) => file.diff).join('\n\n'),
    };
  }
  if (request.toolName === 'apply_sandbox_patch') {
    const bundleId = request.arguments.bundleId;
    if (typeof bundleId !== 'string') throw new Error('Artifact Bundle ID 无效');
    const preview = await previewSandboxPatch(request.workspaceRoot, bundleId);
    return {
      changedFiles: preview.changedFiles,
      diff: preview.files.map((file) => file.diff).join('\n\n'),
    };
  }
  return undefined;
}
