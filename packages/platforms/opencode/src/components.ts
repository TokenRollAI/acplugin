import {
  markdownWithFrontmatter,
  type AgentCapability,
  type AssetService,
  type CanonicalProject,
  type CompatibilityInput,
  type PackageAssetInput,
  type PlatformComponentValidationContext,
} from '@tokenroll/acplugin/sdk';

/** OpenCode 当前不开放未经独立 Schema 验证的 Component 专属字段。 */
const COMPONENT_FIELDS = new Set<string>();

/** OpenCode Agent 可以通过 tools/permission 控制的稳定工具名称。 */
const OPENCODE_TOOLS = ['read', 'glob', 'grep', 'edit', 'bash', 'webfetch', 'task'] as const;

/** OpenCode base Workspace 的 Component 转换结果。 */
export interface OpenCodeComponentPackage {
  readonly assets: readonly PackageAssetInput[];
  readonly compatibility: readonly CompatibilityInput[];
}

/** 校验 OpenCode Component namespace，不允许任意 Frontmatter 透传。 */
export function validateOpenCodeComponent(context: PlatformComponentValidationContext): void {
  /** fields 是 Scanner 已复制冻结的平台 namespace。 */
  const fields = context.component.platforms.opencode ?? {};
  for (const field of Object.keys(fields)) {
    if (!COMPONENT_FIELDS.has(field)) {
      context.diagnostics.report({
        code: 'OPENCODE_COMPONENT_FIELD_UNKNOWN',
        severity: 'error',
        message: `Unknown OpenCode ${context.component.kind} field "${field}".`,
        fieldPath: ['platforms', 'opencode', field],
      });
    }
  }
}

/** @returns canonical Agent capabilities 对应的完整 OpenCode 工具开关。 */
function openCodeTools(capabilities: readonly AgentCapability[]): Readonly<Record<string, boolean>> {
  /** allowed 累积多个 capability 映射到的去重工具。 */
  const allowed = new Set<string>();
  /** mapping 是 canonical capability 到 OpenCode 工具的稳定映射。 */
  const mapping = {
    'filesystem:read': ['read', 'glob', 'grep'],
    'filesystem:write': ['edit'],
    'search': ['glob', 'grep'],
    'shell': ['bash'],
    'network': ['webfetch'],
    'delegate': ['task'],
  } satisfies Record<AgentCapability, readonly string[]>;
  for (const capability of capabilities) {
    for (const tool of mapping[capability])
      allowed.add(tool);
  }
  return Object.freeze(Object.fromEntries(OPENCODE_TOOLS.map(tool => [tool, allowed.has(tool)])));
}

/** @returns 对有副作用或外部访问的 OpenCode 工具给出显式 allow/deny。 */
function openCodePermissions(tools: Readonly<Record<string, boolean>>): Readonly<Record<string, string>> {
  return Object.freeze({
    edit: tools.edit ? 'allow' : 'deny',
    bash: tools.bash ? 'allow' : 'deny',
    webfetch: tools.webfetch ? 'allow' : 'deny',
    task: tools.task ? 'allow' : 'deny',
  });
}

/** 把 canonical Commands、Skills 与 Agents 转换为 OpenCode workspace Assets。 */
export async function createOpenCodeComponents(
  project: CanonicalProject,
  assets: AssetService,
): Promise<OpenCodeComponentPackage> {
  /** output 只包含 Platform 自有 bytes 和 Core 授权的 Skill auxiliary refs。 */
  const output: PackageAssetInput[] = [];
  /** compatibility 精确覆盖三类 canonical Component。 */
  const compatibility: CompatibilityInput[] = [];
  for (const command of project.commands) {
    /** Command Markdown 使用 OpenCode 原生 workspace 目录和参数占位符。 */
    const asset = await assets.fromBytes({
      bytes: markdownWithFrontmatter({ description: command.description }, command.body.replaceAll('{{arguments}}', '$ARGUMENTS')),
      origin: { operation: 'component-command', subjects: [`command:${command.id}`] },
    });
    output.push(Object.freeze({ path: `.opencode/commands/${command.id}.md`, asset }));
    compatibility.push(Object.freeze({
      subject: `command:${command.id}`,
      capability: 'component',
      level: 'native',
      reason: 'OpenCode supports native workspace Commands and the $ARGUMENTS placeholder.',
    }));
    if (command.argumentHint !== undefined) {
      compatibility.push(Object.freeze({
        subject: `command:${command.id}`,
        capability: 'argument-hint',
        level: 'degraded',
        transformation: 'argument-hint-omitted',
        reason: 'OpenCode Command metadata has no verified argument hint field.',
      }));
    }
  }
  for (const skill of project.skills) {
    /** Skill 主文档使用 OpenCode 原生 Agent Skill 结构。 */
    const asset = await assets.fromBytes({
      bytes: markdownWithFrontmatter({ name: skill.id, description: skill.description }, skill.body),
      origin: { operation: 'component-skill', subjects: [`skill:${skill.id}`] },
    });
    output.push(Object.freeze({ path: `.opencode/skills/${skill.id}/SKILL.md`, asset }));
    for (const auxiliary of skill.auxiliaryFiles)
      output.push(Object.freeze({ path: `.opencode/skills/${skill.id}/${auxiliary.path}`, asset: auxiliary.asset }));
    compatibility.push(Object.freeze({
      subject: `skill:${skill.id}`,
      capability: 'component',
      level: 'native',
      reason: 'OpenCode supports native workspace Agent Skills.',
    }));
    if (!skill.invocation.user || !skill.invocation.model) {
      compatibility.push(Object.freeze({
        subject: `skill:${skill.id}`,
        capability: 'invocation',
        level: 'degraded',
        transformation: 'invocation-switches-omitted',
        reason: 'OpenCode has no verified independent user and model invocation switches for Skills.',
      }));
    }
  }
  for (const agent of project.agents) {
    /** tools 是 portable capability 的原生完整开关映射。 */
    const tools = openCodeTools(agent.capabilities);
    /** Agent Markdown 使用 OpenCode 原生 Subagent 配置。 */
    const asset = await assets.fromBytes({
      bytes: markdownWithFrontmatter({
        description: agent.description,
        mode: 'subagent',
        tools,
        permission: openCodePermissions(tools),
      }, agent.body),
      origin: { operation: 'component-agent', subjects: [`agent:${agent.id}`] },
    });
    output.push(Object.freeze({ path: `.opencode/agents/${agent.id}.md`, asset }));
    compatibility.push(
      Object.freeze({
        subject: `agent:${agent.id}`,
        capability: 'component',
        level: 'native',
        reason: 'OpenCode supports native workspace Subagents.',
      }),
      Object.freeze({
        subject: `agent:${agent.id}`,
        capability: 'agent.capabilities',
        level: 'transform',
        transformation: 'native-tools-and-permissions',
        reason: 'OpenCode enforces canonical capabilities through native tools and permission fields.',
      }),
    );
    if (agent.model !== 'inherit') {
      compatibility.push(Object.freeze({
        subject: `agent:${agent.id}`,
        capability: 'agent.model',
        level: 'degraded',
        transformation: 'platform-default-model',
        reason: 'OpenCode has no stable mapping for canonical abstract model classes.',
      }));
    }
  }
  return Object.freeze({ assets: Object.freeze(output), compatibility: Object.freeze(compatibility) });
}
