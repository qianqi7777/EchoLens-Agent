import type { ToolSpec } from './types.js';

/**
 * 工具注册表只负责“有哪些工具”。
 * 真正的权限、预算和超时判断统一放在 ToolExecutor，避免出现多套安全规则。
 */
export class ToolRegistry {
  private readonly items = new Map<string, ToolSpec>();

  register(tool: ToolSpec): void {
    if (this.items.has(tool.name)) {
      throw new Error(`工具已注册：${tool.name}`);
    }
    this.items.set(tool.name, tool);
  }

  get(name: string): ToolSpec {
    const tool = this.items.get(name);
    if (!tool) throw new Error(`未知工具：${name}`);
    return tool;
  }

  list(): ToolSpec[] {
    return [...this.items.values()].sort((a, b) => a.name.localeCompare(b.name));
  }
}

