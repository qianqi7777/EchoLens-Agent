import {
  previewPatch,
  previewSandboxPatch,
  type ApprovalRequest,
} from './runtime/index.js';

/** 审批 UI 的展示数据。`diff` 仅用于人工阅读，不参与任何执行路径。 */
export interface ApprovalPreview {
  changedFiles: string[];
  diff: string;
}

/**
 * 为待审批的动作生成差异预览。
 *
 * 预览必须复用与真正执行相同的补丁规范化逻辑，否则用户批准的 diff 会和实际落盘的内容
 * 不一致，审批就失去意义。
 * @returns 工具没有可预览的形态时返回 `undefined`；这不影响该工具仍需审批。
 */
export async function previewApprovalRequest(request: ApprovalRequest): Promise<ApprovalPreview | undefined> {
  if (request.toolName === 'apply_patch') {
    // 参数来自模型输出，结构上不可信；这里只取出字段，合法性交由 previewPatch 校验。
    const patch = (request.arguments as { patch?: unknown }).patch;
    const preview = await previewPatch(request.workspaceRoot, patch);
    return {
      changedFiles: preview.changedFiles,
      diff: preview.files.map((file) => file.diff).join('\n\n'),
    };
  }
  if (request.toolName === 'apply_sandbox_patch') {
    // 沙箱产物包按 ID 定位，非字符串会让预览退化成空 diff；显式抛错让 UI 显示原因。
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
