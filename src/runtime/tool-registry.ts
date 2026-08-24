import type { ToolSpec } from './types.js';
import {
  compileToolSchema,
  validateToolArguments,
  type ToolArgumentValidation,
} from './tool-schema.js';

interface RegisteredTool {
  spec: ToolSpec;
  validate: ReturnType<typeof compileToolSchema>;
}

/**
 * 工具注册表只负责“有哪些工具”。
 * 真正的权限、预算和超时判断统一放在 ToolExecutor，避免出现多套安全规则。
 */
export class ToolRegistry {
  private readonly items = new Map<string, RegisteredTool>();

  register(tool: ToolSpec): void {
    if (this.items.has(tool.name)) {
      throw new Error(`工具已注册：${tool.name}`);
    }
    this.items.set(tool.name, { spec: tool, validate: compileToolSchema(tool.name, tool.inputSchema) });
  }

  get(name: string): ToolSpec {
    const tool = this.items.get(name);
    if (!tool) throw new Error(`未知工具：${name}`);
    return tool.spec;
  }

  validate(name: string, args: Record<string, unknown>): ToolArgumentValidation {
    const tool = this.items.get(name);
    if (!tool) throw new Error(`未知工具：${name}`);
    return validateToolArguments(tool.validate, args);
  }

  list(): ToolSpec[] {
    return [...this.items.values()].map((item) => item.spec).sort((a, b) => a.name.localeCompare(b.name));
  }
}
