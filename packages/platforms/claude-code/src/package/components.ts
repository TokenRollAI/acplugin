import {
  markdownWithFrontmatter,
  type AgentCapability,
  type AssetService,
  type CanonicalProject,
  type CompatibilityInput,
  type PackageAssetInput,
  type PlatformComponentValidationContext,
} from '@tokenroll/acplugin/sdk';
import type { ClaudeNativeAgentComponent } from '../types.js';

/** 三类 Component 允许的 Claude Code 专属字段。 */
const FIELDS = Object.freeze({
  command: new Set(['allowedTools', 'model']),
  skill: new Set(['allowedTools', 'model', 'context', 'agent']),
  agent: new Set(['tools', 'disallowedTools', 'effort', 'maxTurns', 'skills', 'memory', 'background', 'isolation']),
});

/** Claude Code Agent 支持的枚举值集合。 */
const ENUMS = Object.freeze({
  effort: new Set(['low', 'medium', 'high', 'xhigh', 'max']),
  memory: new Set(['user', 'project', 'local']),
  isolation: new Set(['worktree']),
});

/** 一个 Claude Code base Package 的 Component 转换结果。 */
export interface ClaudeComponentPackage {
  readonly assets: readonly PackageAssetInput[];
  readonly compatibility: readonly CompatibilityInput[];
}

/** @returns 值是否为非空字符串。 */
function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/** @returns 值是否为唯一非空字符串数组。 */
function stringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every(nonEmpty) && new Set(value).size === value.length;
}

/** 报告带 canonical Frontmatter 路径的 Claude Code 字段错误。 */
function fieldError(context: PlatformComponentValidationContext, field: string, message: string): void {
  context.diagnostics.report({
    code: 'CLAUDE_COMPONENT_FIELD_INVALID',
    severity: 'error',
    message,
    fieldPath: ['platforms', 'claude-code', field],
  });
}

/** 校验当前 Component 的 Claude Code namespace，不允许 raw Frontmatter。 */
export function validateClaudeComponent(context: PlatformComponentValidationContext): void {
  /** fields 是 Scanner 已复制冻结的当前 Platform namespace。 */
  const fields = context.component.platforms['claude-code'] ?? {};
  /** allowed 由 canonical Component kind 决定。 */
  const allowed = FIELDS[context.component.kind];
  for (const field of Object.keys(fields)) {
    if (!allowed.has(field)) {
      context.diagnostics.report({
        code: 'CLAUDE_COMPONENT_FIELD_UNKNOWN', severity: 'error',
        message: `Unknown Claude Code ${context.component.kind} field "${field}".`,
        fieldPath: ['platforms', 'claude-code', field],
      });
    }
  }
  for (const field of ['allowedTools', 'tools', 'disallowedTools', 'skills']) {
    if (fields[field] !== undefined && !stringArray(fields[field]))
      fieldError(context, field, `${field} must contain unique non-empty strings.`);
  }
  for (const field of ['model', 'agent']) {
    if (fields[field] !== undefined && !nonEmpty(fields[field]))
      fieldError(context, field, `${field} must be a non-empty string.`);
  }
  if (fields.context !== undefined && fields.context !== 'fork')
    fieldError(context, 'context', 'context must be "fork".');
  for (const field of ['effort', 'memory', 'isolation'] as const) {
    if (fields[field] !== undefined && !ENUMS[field].has(String(fields[field])))
      fieldError(context, field, `${field} is not supported by Claude Code.`);
  }
  if (fields.maxTurns !== undefined && (!Number.isInteger(fields.maxTurns) || Number(fields.maxTurns) <= 0))
    fieldError(context, 'maxTurns', 'maxTurns must be a positive integer.');
  if (fields.background !== undefined && typeof fields.background !== 'boolean')
    fieldError(context, 'background', 'background must be boolean.');
}

/** @returns Agent portable capabilities 的保守 Claude Code tools 映射。 */
function claudeTools(capabilities: readonly AgentCapability[]): readonly string[] {
  /** result 去重多项 capability 指向的相同工具。 */
  const result = new Set<string>();
  /** mapping 固定 portable capability 到 Claude Code 原生工具的最小授权集合。 */
  const mapping: Record<AgentCapability, readonly string[]> = {
    'filesystem:read': ['Read', 'Glob', 'Grep'],
    'filesystem:write': ['Write', 'Edit'],
    'search': ['Glob', 'Grep'],
    'shell': ['Bash'],
    'network': ['WebFetch'],
    'delegate': ['Agent'],
  };
  for (const capability of capabilities) {
    for (const tool of mapping[capability])
      result.add(tool);
  }
  if (capabilities.includes('search') && capabilities.includes('network'))
    result.add('WebSearch');
  return Object.freeze([...result].sort());
}

/** @returns portable model 档位对应的 Claude Code 别名。 */
function claudeModel(model: 'inherit' | 'fast' | 'capable'): string {
  return model === 'fast' ? 'haiku' : model === 'capable' ? 'sonnet' : 'inherit';
}

/** @returns 非空工具数组的官方逗号分隔形式。 */
function toolList(value: unknown): string | undefined {
  return Array.isArray(value) && value.length > 0 ? value.join(', ') : undefined;
}

/** Claude Agent renderer 消费的已验证、Platform-owned frontmatter 输入。 */
export interface ClaudeAgentDocumentInput {
  readonly id: string;
  readonly description: string;
  readonly body: string;
  readonly model: 'inherit' | 'fast' | 'capable';
  readonly tools?: readonly string[];
  readonly disallowedTools?: readonly string[];
  readonly effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  readonly maxTurns?: number;
  readonly skills?: readonly string[];
  readonly memory?: 'user' | 'project' | 'local';
  readonly background?: boolean;
  readonly isolation?: 'worktree';
}

/** 把一个已验证的 Claude Agent 表示为 Platform 固定 Markdown/frontmatter 字节。 */
export function renderClaudeAgent(input: ClaudeAgentDocumentInput): string {
  return markdownWithFrontmatter({
    name: input.id,
    description: input.description,
    model: claudeModel(input.model),
    tools: toolList(input.tools),
    disallowedTools: toolList(input.disallowedTools),
    effort: input.effort,
    maxTurns: input.maxTurns,
    skills: input.skills,
    memory: input.memory,
    background: input.background,
    isolation: input.isolation,
  }, input.body);
}

/** 将 Claude 私有 Component 映射为同一 Agent renderer 的输入。 */
export function claudeNativeAgentDocument(component: ClaudeNativeAgentComponent): ClaudeAgentDocumentInput {
  return Object.freeze({
    id: component.id,
    description: component.description,
    body: component.body,
    model: component.model ?? 'inherit',
    ...(component.tools === undefined ? {} : { tools: component.tools }),
    ...(component.disallowedTools === undefined ? {} : { disallowedTools: component.disallowedTools }),
    ...(component.effort === undefined ? {} : { effort: component.effort }),
    ...(component.maxTurns === undefined ? {} : { maxTurns: component.maxTurns }),
    ...(component.skills === undefined ? {} : { skills: component.skills }),
    ...(component.memory === undefined ? {} : { memory: component.memory }),
    ...(component.background === undefined ? {} : { background: component.background }),
    ...(component.isolation === undefined ? {} : { isolation: component.isolation }),
  });
}

/** 把 canonical Components 转为 Claude Code 原生 Asset 与完整兼容性。 */
export async function createClaudeComponents(project: CanonicalProject, assets: AssetService): Promise<ClaudeComponentPackage> {
  /** output 只包含 Platform 自有生成 Asset 和已授予的 Skill auxiliary refs。 */
  const output: PackageAssetInput[] = [];
  /** compatibility 对每个 canonical Component 精确覆盖 component tuple。 */
  const compatibility: CompatibilityInput[] = [];
  for (const command of project.commands) {
    /** fields 是已由 validateComponent 校验的平台 namespace。 */
    const fields = command.platforms['claude-code'] ?? {};
    /** asset 是由 Platform owner 签发的 Command Markdown。 */
    const asset = await assets.fromBytes({
      bytes: markdownWithFrontmatter({
        'description': command.description,
        'argument-hint': command.argumentHint,
        'allowed-tools': fields.allowedTools,
        'model': fields.model,
      }, command.body.replaceAll('{{arguments}}', '$ARGUMENTS')),
      origin: { operation: 'component-command', subjects: [`command:${command.id}`] },
    });
    output.push(Object.freeze({ path: `commands/${command.id}.md`, asset }));
    compatibility.push(Object.freeze({
      subject: `command:${command.id}`, capability: 'component', level: 'native',
      reason: 'Claude Code supports native plugin Commands.',
    }));
  }
  for (const skill of project.skills) {
    /** fields 是已由 validateComponent 校验的平台 namespace。 */
    const fields = skill.platforms['claude-code'] ?? {};
    /** asset 是由 Platform owner 签发的 Skill 主文档。 */
    const asset = await assets.fromBytes({
      bytes: markdownWithFrontmatter({
        'name': skill.id,
        'description': skill.description,
        'user-invocable': skill.invocation.user,
        'disable-model-invocation': !skill.invocation.model,
        'allowed-tools': fields.allowedTools,
        'model': fields.model,
        'context': fields.context,
        'agent': fields.agent,
      }, skill.body),
      origin: { operation: 'component-skill', subjects: [`skill:${skill.id}`] },
    });
    output.push(Object.freeze({ path: `skills/${skill.id}/SKILL.md`, asset }));
    for (const auxiliary of skill.auxiliaryFiles)
      output.push(Object.freeze({ path: `skills/${skill.id}/${auxiliary.path}`, asset: auxiliary.asset }));
    compatibility.push(Object.freeze({
      subject: `skill:${skill.id}`, capability: 'component', level: 'native',
      reason: 'Claude Code supports native plugin Skills.',
    }));
  }
  for (const agent of project.agents) {
    /** fields 可显式覆盖 portable capability 的保守 tools 映射。 */
    const fields = agent.platforms['claude-code'] ?? {};
    /** tools 优先使用显式平台配置，否则保守映射 portable capabilities。 */
    const tools = stringArray(fields.tools) ? fields.tools : claudeTools(agent.capabilities);
    /** validateComponent 已报告非法字段；renderer 只接受经过同一窄化的值。 */
    const disallowedTools = stringArray(fields.disallowedTools) ? fields.disallowedTools : undefined;
    const skills = stringArray(fields.skills) ? fields.skills : undefined;
    const effort = typeof fields.effort === 'string' && ENUMS.effort.has(fields.effort)
      ? fields.effort as ClaudeAgentDocumentInput['effort']
      : undefined;
    const maxTurns = typeof fields.maxTurns === 'number' && Number.isInteger(fields.maxTurns) && fields.maxTurns > 0
      ? fields.maxTurns
      : undefined;
    const memory = typeof fields.memory === 'string' && ENUMS.memory.has(fields.memory)
      ? fields.memory as ClaudeAgentDocumentInput['memory']
      : undefined;
    const background = typeof fields.background === 'boolean' ? fields.background : undefined;
    const isolation = fields.isolation === 'worktree' ? 'worktree' as const : undefined;
    /** asset 是由 Platform owner 签发的 Agent Markdown。 */
    const asset = await assets.fromBytes({
      bytes: renderClaudeAgent({
        id: agent.id,
        description: agent.description,
        body: agent.body,
        model: agent.model,
        tools,
        ...(disallowedTools === undefined ? {} : { disallowedTools }),
        ...(effort === undefined ? {} : { effort }),
        ...(maxTurns === undefined ? {} : { maxTurns }),
        ...(skills === undefined ? {} : { skills }),
        ...(memory === undefined ? {} : { memory }),
        ...(background === undefined ? {} : { background }),
        ...(isolation === undefined ? {} : { isolation }),
      }),
      origin: { operation: 'component-agent', subjects: [`agent:${agent.id}`] },
    });
    output.push(Object.freeze({ path: `agents/${agent.id}.md`, asset }));
    compatibility.push(Object.freeze({
      subject: `agent:${agent.id}`, capability: 'component', level: 'native',
      reason: 'Claude Code supports native plugin Agents.',
    }));
  }
  return Object.freeze({ assets: Object.freeze(output), compatibility: Object.freeze(compatibility) });
}
