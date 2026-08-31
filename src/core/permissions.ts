/**
 * 运行时可授予的动作权限完整目录，跨模块按固定字符串引用。
 *
 * 按 deny-first 求值：未在运行时授权集合中的动作即被拒绝；规则文件（不可信）
 * 只能收紧权限或申请审批，永远无法新增或放宽权限。新增或改名必须同步
 * `InstructionLoader.DIRECTIVE_PATTERN` 中的同一组白名单，否则规则解析与
 * 运行时权限集合会失配。
 */
export type Permission =
  | 'workspace.read'
  | 'workspace.write'
  | 'process.exec'
  | 'network.request'
  | 'external.invoke';
