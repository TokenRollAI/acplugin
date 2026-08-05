import {
  bytesArtifact,
  markdownWithFrontmatter,
  stableJson,
  stableYaml,
  type Compiler,
  type CompilerContext,
  type CompilerOutput,
  type Component,
} from '@acplugin/core';

/** Codex Compiler 对应的稳定目标平台 ID。 */
export const CODEX_TARGET = 'codex';

/** 只能由 Core Compiler 生成、Module 不得替换的 Codex Plugin 清单字段。 */
const RESERVED_MANIFEST_FIELDS = new Set(['name', 'version', 'description', 'skills']);

/**
 * 将 Module 贡献的非保留字段合并进 Codex Plugin 清单。
 *
 * @param context 当前目标的 Compiler 上下文。
 * @param manifest 正在组装且由调用方持有的清单对象。
 * @throws Module 覆盖保留字段或多个 Module 贡献同名字段时抛出异常。
 */
function mergeManifestFields(context: CompilerContext, manifest: Record<string, unknown>): void {
  /** 记录每个扩展字段的唯一贡献 Module，防止依赖顺序静默决定结果。 */
  const owners = new Map<string, string>();
  for (const { module, contribution } of context.contributions) {
    for (const [key, value] of Object.entries(contribution.manifestFields ?? {})) {
      if (RESERVED_MANIFEST_FIELDS.has(key))
        throw new Error(`Module ${module} cannot replace reserved manifest field ${key}.`);
      /** 已经声明当前扩展字段的 Module。 */
      const owner = owners.get(key);
      if (owner)
        throw new Error(`Manifest field ${key} is contributed by both ${owner} and ${module}.`);
      owners.set(key, module);
      manifest[key] = value;
    }
  }
}

/**
 * 判断 Component 是否直接或通过 Skill 依赖最终需要 Agent。
 *
 * Codex 会把自定义 Agent 降级为 Skill，因此依赖方也需要产生传递性降级报告。
 *
 * @param component 当前检查的 Component。
 * @param byKey 全部 Component 的类型与 ID 索引。
 * @param seen 当前递归已访问节点，用于防止异常依赖图导致无限递归。
 * @returns 依赖闭包中包含 Agent 时返回 true。
 */
function requiresAgent(component: Component, byKey: ReadonlyMap<string, Component>, seen = new Set<string>()): boolean {
  /** 当前 Component 在依赖图中的唯一键。 */
  const key = `${component.kind}:${component.id}`;
  if (seen.has(key))
    return false;
  seen.add(key);
  if (component.requires.agents.length > 0)
    return true;
  return component.requires.skills.some((id) => {
    const dependency = byKey.get(`skill:${id}`);
    return dependency ? requiresAgent(dependency, byKey, seen) : false;
  });
}

/**
 * 为不允许模型隐式调用的 Codex Skill 生成 agents/openai.yaml。
 *
 * @param modelInvocation 规范 Skill 是否允许模型自主调用。
 * @returns 需要限制时返回 YAML，否则不生成元数据文件。
 */
function skillMetadata(modelInvocation: boolean): string | undefined {
  if (modelInvocation)
    return undefined;
  return `${stableYaml({ policy: { allow_implicit_invocation: false } })}\n`;
}

/** 将规范 PluginProject 编译为可安装的 Codex Plugin 目录。 */
export const codexCompiler: Compiler = {
  id: CODEX_TARGET,
  /**
   * 编译原生 Skills，并把 Commands、Agents 转换为具有兼容性报告的 Skill 形式。
   *
   * @param context Core 提供的规范工程、目标配置和 Module 贡献。
   * @returns 尚未写盘、将由 ArtifactGraph 统一校验的产物与兼容性记录。
   */
  async compile(context): Promise<CompilerOutput> {
    /** 当前目标累计生成的 Artifact 输入。 */
    const artifacts = [];
    /** 原生、转换和降级映射产生的兼容性结论。 */
    const compatibility = [];
    /** 以大小写不敏感方式保留的最终 Codex Skill ID 与来源。 */
    const generatedIds = new Map<string, string>();
    /** 用于依赖闭包分析的全部规范 Component。 */
    const allComponents: Component[] = [...context.project.commands, ...context.project.skills, ...context.project.agents];
    /** 按类型与 ID 索引的 Component 依赖图节点。 */
    const byKey = new Map(allComponents.map(component => [`${component.kind}:${component.id}`, component]));

    /**
     * 为最终生成的 Codex Skill ID 建立跨平台大小写不敏感的唯一性约束。
     *
     * @param id 待保留的最终 Skill ID。
     * @param subject 产生该 ID 的规范 Component。
     */
    const reserve = (id: string, subject: string): void => {
      /** 已经占用同一大小写不敏感 ID 的 Component。 */
      const collision = generatedIds.get(id.toLocaleLowerCase('en-US'));
      if (collision)
        throw new Error(`Generated Codex Skill ID collision: ${collision} and ${subject} both use ${id}.`);
      generatedIds.set(id.toLocaleLowerCase('en-US'), subject);
    };

    for (const skill of context.project.skills) {
      reserve(skill.id, `skill:${skill.id}`);
      artifacts.push(bytesArtifact(`skills/${skill.id}/SKILL.md`, markdownWithFrontmatter({
        name: skill.id,
        description: skill.description,
      }, skill.body)));
      /** 禁止模型隐式调用时需要生成的 Codex Skill 元数据。 */
      const metadata = skillMetadata(skill.invocation.model);
      if (metadata)
        artifacts.push(bytesArtifact(`skills/${skill.id}/agents/openai.yaml`, metadata));
      for (const auxiliary of skill.auxiliaryFiles) {
        artifacts.push({
          path: `skills/${skill.id}/${auxiliary.path}`,
          source: { type: 'file' as const, path: auxiliary.sourcePath },
          mode: auxiliary.mode,
        });
      }
      if (!skill.invocation.user) {
        compatibility.push({
          target: CODEX_TARGET,
          subject: `skill:${skill.id}`,
          capability: 'invocation.user',
          level: 'degraded',
          transformation: 'The Skill remains explicitly invocable.',
          reason: 'Codex Skill metadata cannot disable explicit user invocation.',
        } as const);
      } else {
        compatibility.push({ target: CODEX_TARGET, subject: `skill:${skill.id}`, capability: 'component', level: 'native', reason: 'Codex supports plugin Skills.' } as const);
      }
    }

    for (const command of context.project.commands) {
      /** Command 降级生成的显式调用 Skill ID。 */
      const id = `command-${command.id}`;
      reserve(id, `command:${command.id}`);
      artifacts.push(bytesArtifact(`skills/${id}/SKILL.md`, markdownWithFrontmatter({
        name: id,
        description: command.description,
      }, command.body.replaceAll('{{arguments}}', 'the arguments supplied with this explicit invocation'))));
      artifacts.push(bytesArtifact(`skills/${id}/agents/openai.yaml`, skillMetadata(false)!));
      compatibility.push({
        target: CODEX_TARGET,
        subject: `command:${command.id}`,
        capability: 'component',
        level: 'transform',
        transformation: `Explicit Skill ${id}`,
        reason: 'Codex represents Commands as explicitly invoked Skills.',
      } as const);
    }

    for (const agent of context.project.agents) {
      /** Agent 降级生成的指导型 Skill ID。 */
      const id = `agent-${agent.id}`;
      reserve(id, `agent:${agent.id}`);
      /** 保留 Agent 意图但明确平台无法强制模型与能力的降级正文。 */
      const guidance = [
        agent.body,
        '',
        `Intended model class: ${agent.model}.`,
        `Intended capabilities: ${agent.capabilities.join(', ') || 'none declared'}.`,
        'When delegation is available, use a focused subagent with this role. These settings are guidance, not enforced registration.',
      ].join('\n');
      artifacts.push(bytesArtifact(`skills/${id}/SKILL.md`, markdownWithFrontmatter({
        name: id,
        description: agent.description,
      }, guidance)));
      compatibility.push({
        target: CODEX_TARGET,
        subject: `agent:${agent.id}`,
        capability: 'component',
        level: 'degraded',
        transformation: `Model-only fallback Skill ${id}`,
        reason: 'Codex installable plugins cannot register project/user custom Agents; model and capability enforcement are lost.',
      } as const);
    }

    for (const component of allComponents) {
      if (component.kind !== 'agent' && requiresAgent(component, byKey)) {
        compatibility.push({
          target: CODEX_TARGET,
          subject: `${component.kind}:${component.id}`,
          capability: 'requires.agents',
          level: 'degraded',
          reason: 'A required Agent is degraded to a fallback Skill on Codex.',
          causes: component.requires.agents.map(id => `agent:${id}`),
        } as const);
      }
    }

    /** 由 Core 字段和 Module 扩展共同构成的 Codex Plugin 清单。 */
    const manifest: Record<string, unknown> = {
      name: context.project.name,
      version: context.project.version,
      description: context.project.description,
    };
    if (generatedIds.size > 0)
      manifest.skills = './skills/';
    mergeManifestFields(context, manifest);
    artifacts.push(bytesArtifact('.codex-plugin/plugin.json', stableJson(manifest)));

    return { artifacts, compatibility };
  },
};

/** 默认导出便于直接注册该官方 Compiler。 */
export default codexCompiler;
