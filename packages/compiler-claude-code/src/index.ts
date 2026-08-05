import {
  bytesArtifact,
  markdownWithFrontmatter,
  stableJson,
  type AgentCapability,
  type Compiler,
  type CompilerContext,
  type CompilerOutput,
} from '@acplugin/core';

/** Claude Code Compiler 对应的稳定目标平台 ID。 */
export const CLAUDE_CODE_TARGET = 'claude-code';

/** 只能由 Core Compiler 生成、Module 不得替换的 Claude Plugin 清单字段。 */
const RESERVED_MANIFEST_FIELDS = new Set([
  'name', 'version', 'description', 'commands', 'skills', 'agents',
]);

/**
 * 将 Module 贡献的非保留字段合并进 Claude Plugin 清单。
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
 * 把 Core 可移植 Agent 能力映射为 Claude Code 工具白名单。
 *
 * @param capabilities Agent 声明的规范能力。
 * @returns 去重并稳定排序的 Claude Code 工具名称。
 */
function claudeTools(capabilities: readonly AgentCapability[]): string[] {
  /** 多种能力可能指向同一工具，因此先使用 Set 去重。 */
  const result = new Set<string>();
  for (const capability of capabilities) {
    for (const tool of ({
      'filesystem:read': ['Read', 'Glob', 'Grep'],
      'filesystem:write': ['Write', 'Edit'],
      'search': ['Glob', 'Grep', 'WebSearch'],
      'shell': ['Bash'],
      'network': ['WebFetch', 'WebSearch'],
      'delegate': ['Agent'],
    } satisfies Record<AgentCapability, string[]>)[capability])
      result.add(tool);
  }
  return [...result].sort();
}

/**
 * 把 Core 模型档位映射为 Claude Code Agent 支持的模型别名。
 *
 * @param model 可移植模型档位。
 * @returns Claude Code frontmatter 使用的模型值。
 */
function claudeModel(model: 'inherit' | 'fast' | 'capable'): string {
  if (model === 'fast')
    return 'haiku';
  if (model === 'capable')
    return 'sonnet';
  return 'inherit';
}

/** 将规范 PluginProject 编译为可安装的 Claude Code Plugin 目录。 */
export const claudeCodeCompiler: Compiler = {
  id: CLAUDE_CODE_TARGET,
  /**
   * 编译 Commands、Skills、Agents、Module 贡献和 Plugin 清单。
   *
   * @param context Core 提供的规范工程、目标配置和 Module 贡献。
   * @returns 尚未写盘、将由 ArtifactGraph 统一校验的产物与兼容性记录。
   */
  async compile(context): Promise<CompilerOutput> {
    /** 当前目标累计生成的 Artifact 输入。 */
    const artifacts = [];
    /** 当前目标每种 Component 映射的兼容性结论。 */
    const compatibility = [];
    /** 便于各 Component 转换共享的规范工程。 */
    const { project } = context;

    for (const command of project.commands) {
      /** Claude Command frontmatter，参数提示仅在存在时输出。 */
      const frontmatter: Record<string, unknown> = { description: command.description };
      if (command.argumentHint)
        frontmatter['argument-hint'] = command.argumentHint;
      artifacts.push(bytesArtifact(
        `commands/${command.id}.md`,
        markdownWithFrontmatter(frontmatter, command.body.replaceAll('{{arguments}}', '$ARGUMENTS')),
      ));
      compatibility.push({ target: CLAUDE_CODE_TARGET, subject: `command:${command.id}`, capability: 'component', level: 'native', reason: 'Claude Code supports plugin Commands.' } as const);
    }

    for (const skill of project.skills) {
      artifacts.push(bytesArtifact(`skills/${skill.id}/SKILL.md`, markdownWithFrontmatter({
        'name': skill.id,
        'description': skill.description,
        'user-invocable': skill.invocation.user,
        'disable-model-invocation': !skill.invocation.model,
      }, skill.body)));
      for (const auxiliary of skill.auxiliaryFiles) {
        artifacts.push({
          path: `skills/${skill.id}/${auxiliary.path}`,
          source: { type: 'file' as const, path: auxiliary.sourcePath },
          mode: auxiliary.mode,
        });
      }
      compatibility.push({ target: CLAUDE_CODE_TARGET, subject: `skill:${skill.id}`, capability: 'component', level: 'native', reason: 'Claude Code supports plugin Skills.' } as const);
    }

    for (const agent of project.agents) {
      /** 从规范能力映射并去重得到的 Claude Code 工具列表。 */
      const tools = claudeTools(agent.capabilities);
      artifacts.push(bytesArtifact(`agents/${agent.id}.md`, markdownWithFrontmatter({
        name: agent.id,
        description: agent.description,
        model: claudeModel(agent.model),
        tools: tools.length > 0 ? tools : undefined,
      }, agent.body)));
      compatibility.push({ target: CLAUDE_CODE_TARGET, subject: `agent:${agent.id}`, capability: 'component', level: 'native', reason: 'Claude Code supports plugin Agents.' } as const);
    }

    /** 由 Core 字段和 Module 扩展共同构成的 Claude Plugin 清单。 */
    const manifest: Record<string, unknown> = {
      name: project.name,
      version: project.version,
      description: project.description,
    };
    if (project.commands.length > 0)
      manifest.commands = './commands/';
    if (project.skills.length > 0)
      manifest.skills = './skills/';
    if (project.agents.length > 0)
      manifest.agents = './agents/';
    mergeManifestFields(context, manifest);
    artifacts.push(bytesArtifact('.claude-plugin/plugin.json', stableJson(manifest)));

    return { artifacts, compatibility };
  },
};

/** 默认导出便于直接注册该官方 Compiler。 */
export default claudeCodeCompiler;
