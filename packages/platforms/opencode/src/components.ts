import {
  bytesArtifact,
  markdownWithFrontmatter,
  type AgentCapability,
  type ArtifactInput,
  type PlatformComponentValidationContext,
  type PlatformGenerateContext,
} from '@tokenroll/acplugin';

/** OpenCode 1.0 暂不开放未经独立 Schema 验证的 Component 专属字段。 */
const COMPONENT_FIELDS = new Set<string>();

/** OpenCode Agent 可以通过 tools/permission 控制的稳定工具名称。 */
const OPENCODE_TOOLS = ['read', 'glob', 'grep', 'edit', 'bash', 'webfetch', 'task'] as const;

/**
 * 校验 OpenCode Component 专属字段，阻止任意 Frontmatter 透传。
 *
 * @param context Core 规范化并冻结后的字段校验上下文。
 */
export function validateOpenCodeComponentFields(context: PlatformComponentValidationContext): void {
  for (const field of Object.keys(context.fields)) {
    if (!COMPONENT_FIELDS.has(field)) {
      context.reportDiagnostic({
        code: 'OPENCODE_COMPONENT_FIELD_UNKNOWN',
        severity: 'error',
        message: `Unknown OpenCode ${context.component.kind} field "${field}".`,
        fieldPath: ['platforms', 'opencode', field],
      });
    }
  }
}

/**
 * 把规范 Agent 能力映射为 OpenCode 工具开关。
 *
 * @param capabilities Agent 声明的规范能力。
 * @returns 每个稳定工具都显式允许或拒绝的确定性对象。
 */
function openCodeTools(capabilities: readonly AgentCapability[]): Readonly<Record<string, boolean>> {
  /** 规范能力映射后的允许工具集合。 */
  const allowed = new Set<string>();
  for (const capability of capabilities) {
    /** tool 表示当前能力拥有的一个 OpenCode 工具。 */
    for (const tool of ({
      'filesystem:read': ['read', 'glob', 'grep'],
      'filesystem:write': ['edit'],
      'search': ['glob', 'grep'],
      'shell': ['bash'],
      'network': ['webfetch'],
      'delegate': ['task'],
    } satisfies Record<AgentCapability, readonly string[]>)[capability])
      allowed.add(tool);
  }
  return Object.freeze(Object.fromEntries(OPENCODE_TOOLS.map(tool => [tool, allowed.has(tool)])));
}

/**
 * 把规范 Agent 能力映射为 OpenCode permission 决策。
 *
 * @param tools 已完成能力映射的工具开关。
 * @returns 对具有副作用或外部访问能力的工具给出显式 allow/deny。
 */
function openCodePermissions(tools: Readonly<Record<string, boolean>>): Readonly<Record<string, string>> {
  return Object.freeze({
    edit: tools.edit ? 'allow' : 'deny',
    bash: tools.bash ? 'allow' : 'deny',
    webfetch: tools.webfetch ? 'allow' : 'deny',
    task: tools.task ? 'allow' : 'deny',
  });
}

/**
 * 把规范 Commands、Skills 与 Agents 转换为 OpenCode workspace 资源。
 *
 * @param context Platform generateBundle 生命周期上下文。
 * @returns 确定排序且尚未进入 DeliveryUnit Registry 的 Artifact 输入。
 */
export function generateComponentArtifacts(context: PlatformGenerateContext): ArtifactInput[] {
  /** 当前 Platform 累计生成的 Component Artifact。 */
  const artifacts: ArtifactInput[] = [];
  for (const command of context.project.commands) {
    artifacts.push(bytesArtifact(`.opencode/commands/${command.id}.md`, markdownWithFrontmatter({
      description: command.description,
    }, command.body.replaceAll('{{arguments}}', '$ARGUMENTS'))));
    context.reportCompatibility({
      subject: `command:${command.id}`,
      capability: 'component',
      level: 'native',
      reason: 'OpenCode supports workspace Commands and the $ARGUMENTS placeholder.',
    });
    if (command.argumentHint !== undefined) {
      context.reportCompatibility({
        subject: `command:${command.id}`,
        capability: 'argumentHint',
        level: 'degraded',
        transformation: 'The Command remains callable without argument hint UI.',
        reason: 'OpenCode Command metadata has no verified argument hint field.',
      });
    }
  }

  for (const skill of context.project.skills) {
    artifacts.push(bytesArtifact(`.opencode/skills/${skill.id}/SKILL.md`, markdownWithFrontmatter({
      name: skill.id,
      description: skill.description,
    }, skill.body)));
    for (const auxiliary of skill.auxiliaryFiles) {
      artifacts.push({
        path: `.opencode/skills/${skill.id}/${auxiliary.path}`,
        source: { type: 'file', path: auxiliary.sourcePath },
        mode: auxiliary.mode,
      });
    }
    context.reportCompatibility({
      subject: `skill:${skill.id}`,
      capability: 'component',
      level: 'native',
      reason: 'OpenCode supports workspace Agent Skills natively.',
    });
    if (!skill.invocation.user || !skill.invocation.model) {
      context.reportCompatibility({
        subject: `skill:${skill.id}`,
        capability: 'invocation',
        level: 'degraded',
        transformation: 'The Skill remains available to both users and the model.',
        reason: 'OpenCode has no verified independent user/model invocation switches for Skills.',
      });
    }
  }

  for (const agent of context.project.agents) {
    /** 根据规范能力创建精确的工具开关。 */
    const tools = openCodeTools(agent.capabilities);
    artifacts.push(bytesArtifact(`.opencode/agents/${agent.id}.md`, markdownWithFrontmatter({
      description: agent.description,
      mode: 'subagent',
      tools,
      permission: openCodePermissions(tools),
    }, agent.body)));
    context.reportCompatibility({
      subject: `agent:${agent.id}`,
      capability: 'component',
      level: 'native',
      reason: 'OpenCode supports workspace Subagents natively.',
    });
    context.reportCompatibility({
      subject: `agent:${agent.id}`,
      capability: 'agent.capabilities',
      level: 'transform',
      transformation: 'Canonical capabilities become OpenCode tools and permission fields.',
      reason: 'OpenCode can enforce the canonical capability boundary through native configuration.',
    });
    if (agent.model !== 'inherit') {
      context.reportCompatibility({
        subject: `agent:${agent.id}`,
        capability: 'agent.model',
        level: 'degraded',
        transformation: 'OpenCode chooses its current platform default model.',
        reason: 'acplugin does not hard-code a changing OpenCode model ID for abstract model classes.',
      });
    }
  }
  return artifacts;
}
