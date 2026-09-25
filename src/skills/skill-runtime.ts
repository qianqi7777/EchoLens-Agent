import type { LoadedSkill, SkillCatalogEntry, SkillLoader } from './loader.js';

/**
 * Skill 的渐进式运行时接口：catalog 不携带正文，只有显式命中后才加载正文，
 * references 按文件读取。这里不提供脚本执行 API；脚本必须由调用方转换为现有
 * ToolExecutor 的受控工具调用，不能从 Skill 运行时绕过 Sandbox 和审批链。
 */
export class SkillRuntime {
  constructor(private readonly loader: SkillLoader) {}

  async activate(name: string): Promise<LoadedSkill> {
    return this.loader.load(name);
  }

  async readReference(skill: LoadedSkill | SkillCatalogEntry, name: string): Promise<string> {
    return this.loader.readReference(skill, name);
  }
}
