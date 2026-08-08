import {
  bytesArtifact,
  markdownWithFrontmatter,
  type AgentCapability,
  type ArtifactInput,
  type Component,
  type PlatformComponentValidationContext,
  type PlatformGenerateContext,
  type PluginProject,
} from '@acplugin/core';

/** Command 允许补充的 Claude Code 专属字段。 */
const COMMAND_FIELDS = new Set(['allowedTools', 'model']);

/** Skill 允许补充的 Claude Code 专属字段。 */
const SKILL_FIELDS = new Set(['allowedTools', 'model', 'context', 'agent']);

/** Agent 允许补充的 Claude Code 专属字段。 */
const AGENT_FIELDS = new Set([
  'tools', 'disallowedTools', 'effort', 'maxTurns', 'skills', 'memory', 'background', 'isolation',
]);

/** Claude Code Agent 支持的推理投入等级。 */
const EFFORT_LEVELS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

/** Claude Code Agent 支持的持久记忆范围。 */
const MEMORY_SCOPES = new Set(['user', 'project', 'local']);

/** Claude Code Agent 当前支持的隔离模式。 */
const ISOLATION_MODES = new Set(['worktree']);

/** 不同 Component 类型对应的 Claude Code 专属字段集合。 */
const FIELDS_BY_KIND = {
  command: COMMAND_FIELDS,
  skill: SKILL_FIELDS,
  agent: AGENT_FIELDS,
} satisfies Record<Component['kind'], ReadonlySet<string>>;

/** 把未知 JSON 字段收窄为普通只读对象。 */
type UnknownFields = Readonly<Record<string, unknown>>;

/**
 * 判断值是否为非空字符串。
 *
 * @param value 待检查的 Component 平台字段。
 * @returns 字段可以安全写入 Frontmatter 时返回 true。
 */
function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * 判断值是否为不含空项和重复项的字符串数组。
 *
 * @param value 待检查的 Component 平台字段。
 * @returns 字段可以稳定写入 Frontmatter 时返回 true。
 */
function isUniqueStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value)
    && value.every(isNonEmptyString)
    && new Set(value).size === value.length;
}

/**
 * 提交一个带完整字段路径的 Claude Code Component Schema 错误。
 *
 * @param context Core 提供的字段校验上下文。
 * @param field 当前错误字段名。
 * @param message 面向作者的稳定错误信息。
 */
function reportFieldError(
  context: PlatformComponentValidationContext,
  field: string,
  message: string,
): void {
  context.reportDiagnostic({
    code: 'CLAUDE_COMPONENT_FIELD_INVALID',
    severity: 'error',
    message,
    fieldPath: ['platforms', 'claude-code', field],
  });
}

/**
 * 校验 Claude Code Component 专属字段，不允许 raw Frontmatter 逃逸。
 *
 * @param context Core 规范化并冻结后的字段校验上下文。
 */
export function validateClaudeComponentFields(context: PlatformComponentValidationContext): void {
  /** 当前 Component 类型明确允许的字段名。 */
  const allowed = FIELDS_BY_KIND[context.component.kind];
  for (const field of Object.keys(context.fields)) {
    if (!allowed.has(field)) {
      context.reportDiagnostic({
        code: 'CLAUDE_COMPONENT_FIELD_UNKNOWN',
        severity: 'error',
        message: `Unknown Claude Code ${context.component.kind} field "${field}".`,
        fieldPath: ['platforms', 'claude-code', field],
      });
    }
  }

  /** fields 是便于按字段名执行精确 Schema 校验的只读视图。 */
  const fields: UnknownFields = context.fields;
  /** 数组型工具或 Skill 字段使用同一非空、去重规则。 */
  const arrayFields = ['allowedTools', 'tools', 'disallowedTools', 'skills'];
  for (const field of arrayFields) {
    if (fields[field] !== undefined && !isUniqueStringArray(fields[field]))
      reportFieldError(context, field, `${field} must be an array of unique non-empty strings.`);
  }
  /** 普通字符串字段不能接收空字符串或其他 JSON 类型。 */
  const stringFields = ['model', 'agent'];
  for (const field of stringFields) {
    if (fields[field] !== undefined && !isNonEmptyString(fields[field]))
      reportFieldError(context, field, `${field} must be a non-empty string.`);
  }
  if (fields.context !== undefined && fields.context !== 'fork')
    reportFieldError(context, 'context', 'context must be "fork".');
  if (fields.effort !== undefined && !EFFORT_LEVELS.has(String(fields.effort)))
    reportFieldError(context, 'effort', 'effort must be low, medium, high, xhigh, or max.');
  if (fields.maxTurns !== undefined && (!Number.isInteger(fields.maxTurns) || Number(fields.maxTurns) <= 0))
    reportFieldError(context, 'maxTurns', 'maxTurns must be a positive integer.');
  if (fields.memory !== undefined && !MEMORY_SCOPES.has(String(fields.memory)))
    reportFieldError(context, 'memory', 'memory must be user, project, or local.');
  if (fields.background !== undefined && typeof fields.background !== 'boolean')
    reportFieldError(context, 'background', 'background must be a boolean.');
  if (fields.isolation !== undefined && !ISOLATION_MODES.has(String(fields.isolation)))
    reportFieldError(context, 'isolation', 'isolation must be "worktree".');
}

/**
 * 读取 Component 中已由 Scanner 校验的 Claude Code 专属字段。
 *
 * @param component 当前准备转换的规范 Component。
 * @returns 缺省为空对象的平台字段视图。
 */
function claudeFields(component: Component): UnknownFields {
  return component.platforms['claude-code'] ?? {};
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
      'search': ['Glob', 'Grep'],
      'shell': ['Bash'],
      'network': ['WebFetch'],
      'delegate': ['Agent'],
    } satisfies Record<AgentCapability, string[]>)[capability])
      result.add(tool);
  }
  // WebSearch 同时具有检索和联网语义，只有两项能力都声明时才能授予，避免扩大 Agent 权限。
  if (capabilities.includes('search') && capabilities.includes('network'))
    result.add('WebSearch');
  return [...result].sort((left, right) => left.localeCompare(right, 'en'));
}

/**
 * 把 Core 模型档位映射为 Claude Code Agent 稳定模型别名。
 *
 * @param model 平台中立的模型档位。
 * @returns Claude Code Agent Frontmatter 使用的模型值。
 */
function claudeModel(model: 'inherit' | 'fast' | 'capable'): string {
  if (model === 'fast')
    return 'haiku';
  if (model === 'capable')
    return 'sonnet';
  return 'inherit';
}

/**
 * 把 Claude Code Frontmatter 的工具列表序列化为官方逗号分隔形式。
 *
 * @param tools 已完成非空和去重校验的精确工具名列表。
 * @returns 非空列表的稳定字符串，空列表返回 undefined。
 */
function toolList(tools: readonly string[] | undefined): string | undefined {
  return tools === undefined || tools.length === 0 ? undefined : tools.join(', ');
}

/**
 * 把规范 Commands、Skills 与 Agents 转换为 Claude Code 原生文件。
 *
 * @param context Platform generateBundle 生命周期上下文。
 * @returns 确定排序且尚未进入 DeliveryUnit Registry 的 Artifact 输入。
 */
export function generateComponentArtifacts(context: PlatformGenerateContext): ArtifactInput[] {
  /** 当前 Platform 累计生成的 Component Artifact。 */
  const artifacts: ArtifactInput[] = [];
  for (const command of context.project.commands) {
    /** 当前 Command 已验证的 Claude Code 专属字段。 */
    const fields = claudeFields(command);
    /** Claude Code Command Frontmatter 的结构化字段。 */
    const frontmatter: Record<string, unknown> = {
      'description': command.description,
      'argument-hint': command.argumentHint,
      'allowed-tools': fields.allowedTools,
      'model': fields.model,
    };
    artifacts.push(bytesArtifact(
      `commands/${command.id}.md`,
      markdownWithFrontmatter(frontmatter, command.body.replaceAll('{{arguments}}', '$ARGUMENTS')),
    ));
    context.reportCompatibility({
      subject: `command:${command.id}`,
      capability: 'component',
      level: 'native',
      reason: 'Claude Code supports plugin Commands and native argument placeholders.',
    });
  }

  for (const skill of context.project.skills) {
    /** 当前 Skill 已验证的 Claude Code 专属字段。 */
    const fields = claudeFields(skill);
    artifacts.push(bytesArtifact(`skills/${skill.id}/SKILL.md`, markdownWithFrontmatter({
      'name': skill.id,
      'description': skill.description,
      'user-invocable': skill.invocation.user,
      'disable-model-invocation': !skill.invocation.model,
      'allowed-tools': fields.allowedTools,
      'model': fields.model,
      'context': fields.context,
      'agent': fields.agent,
    }, skill.body)));
    for (const auxiliary of skill.auxiliaryFiles) {
      artifacts.push({
        path: `skills/${skill.id}/${auxiliary.path}`,
        source: { type: 'file', path: auxiliary.sourcePath },
        mode: auxiliary.mode,
      });
    }
    context.reportCompatibility({
      subject: `skill:${skill.id}`,
      capability: 'component',
      level: 'native',
      reason: 'Claude Code supports plugin Skills and both invocation switches.',
    });
  }

  for (const agent of context.project.agents) {
    /** 当前 Agent 已验证的 Claude Code 专属字段。 */
    const fields = claudeFields(agent);
    /** 精确平台工具约束存在时优先于规范能力的保守映射。 */
    const tools = fields.tools as readonly string[] | undefined ?? claudeTools(agent.capabilities);
    artifacts.push(bytesArtifact(`agents/${agent.id}.md`, markdownWithFrontmatter({
      name: agent.id,
      description: agent.description,
      model: claudeModel(agent.model),
      tools: toolList(tools),
      disallowedTools: toolList(fields.disallowedTools as readonly string[] | undefined),
      effort: fields.effort,
      maxTurns: fields.maxTurns,
      skills: fields.skills,
      memory: fields.memory,
      background: fields.background,
      isolation: fields.isolation,
    }, agent.body)));
    context.reportCompatibility({
      subject: `agent:${agent.id}`,
      capability: 'component',
      level: 'native',
      reason: 'Claude Code supports plugin Agents, model aliases, and tool constraints.',
    });
  }
  return artifacts;
}

/**
 * 判断工程是否包含某类 Component，以便清单只声明实际目录。
 *
 * @param project 已完成扫描和依赖图校验的规范工程。
 * @param kind 待检查的 Component 类型。
 * @returns 对应目录需要进入 Plugin 清单时返回 true。
 */
export function hasComponents(project: PluginProject, kind: Component['kind']): boolean {
  if (kind === 'command')
    return project.commands.length > 0;
  if (kind === 'skill')
    return project.skills.length > 0;
  return project.agents.length > 0;
}
