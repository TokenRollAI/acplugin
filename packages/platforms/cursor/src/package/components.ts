import {
  markdownWithFrontmatter,
  type AgentCapability,
  type AssetService,
  type CanonicalProject,
  type CompatibilityInput,
  type PackageAssetInput,
  type PlatformComponentValidationContext,
} from '@tokenroll/acplugin/sdk';
import type { CursorNativeAgentComponent } from '../types.js';

/** Cursor 当前不开放任何未经独立 Schema 验证的 Component 专属字段。 */
const COMPONENT_FIELDS = new Set<string>();

/** Cursor base Package 的 Component 转换结果。 */
export interface CursorComponentPackage {
  readonly assets: readonly PackageAssetInput[];
  readonly compatibility: readonly CompatibilityInput[];
}

/** 校验 Cursor Component namespace，不允许 raw Frontmatter 逃逸。 */
export function validateCursorComponent(context: PlatformComponentValidationContext): void {
  /** fields 是 Scanner 已复制冻结的 Cursor namespace。 */
  const fields = context.component.platforms.cursor ?? {};
  for (const field of Object.keys(fields)) {
    if (!COMPONENT_FIELDS.has(field)) {
      context.diagnostics.report({
        code: 'CURSOR_COMPONENT_FIELD_UNKNOWN',
        severity: 'error',
        message: `Unknown Cursor ${context.component.kind} field "${field}".`,
        fieldPath: ['platforms', 'cursor', field],
      });
    }
  }
}

/** @returns Agent portable capabilities 是否能精确收敛为 Cursor readonly。 */
function isReadOnly(capabilities: readonly AgentCapability[]): boolean {
  return capabilities.every(capability => capability === 'filesystem:read' || capability === 'search');
}

/** Cursor Native Subagent renderer 的已验证 Platform-owned 输入。 */
export interface CursorAgentDocumentInput {
  readonly id: string;
  readonly description: string;
  readonly body: string;
  readonly readonly?: boolean;
}

/** 以 Cursor 自己的 Subagent frontmatter 渲染 Agent。 */
export function renderCursorAgent(input: CursorAgentDocumentInput): string {
  return markdownWithFrontmatter({
    name: input.id,
    description: input.description,
    ...(input.readonly === true ? { readonly: true } : {}),
  }, input.body);
}

/** 将 Cursor 私有 Component 映射为 Cursor Agent renderer 输入。 */
export function cursorNativeAgentDocument(component: CursorNativeAgentComponent): CursorAgentDocumentInput {
  return Object.freeze({
    id: component.id,
    description: component.description,
    body: component.body,
    ...(component.readonly === undefined ? {} : { readonly: component.readonly }),
  });
}

/** 把 canonical Commands、Skills 与 Agents 转换为 Cursor 原生 Assets。 */
export async function createCursorComponents(
  project: CanonicalProject,
  assets: AssetService,
): Promise<CursorComponentPackage> {
  /** output 只包含 Platform 自有 bytes 和 Core 授权的 Skill auxiliary refs。 */
  const output: PackageAssetInput[] = [];
  /** compatibility 对每个 Component 精确覆盖 component tuple 与实际语义差异。 */
  const compatibility: CompatibilityInput[] = [];
  for (const command of project.commands) {
    /** Command Markdown 使用 Cursor 原生参数占位符。 */
    const asset = await assets.fromBytes({
      bytes: markdownWithFrontmatter({ description: command.description }, command.body.replaceAll('{{arguments}}', '$ARGUMENTS')),
      origin: { operation: 'component-command', subjects: [`command:${command.id}`] },
    });
    output.push(Object.freeze({ path: `commands/${command.id}.md`, asset }));
    compatibility.push(Object.freeze({
      subject: `command:${command.id}`,
      capability: 'component',
      level: 'native',
      reason: 'Cursor supports native Plugin Commands and the $ARGUMENTS placeholder.',
    }));
    if (command.argumentHint !== undefined) {
      compatibility.push(Object.freeze({
        subject: `command:${command.id}`,
        capability: 'argument-hint',
        level: 'degraded',
        transformation: 'argument-hint-omitted',
        reason: 'Cursor Command metadata has no verified argument hint field.',
      }));
    }
  }
  for (const skill of project.skills) {
    /** Skill 主文档保留 Cursor 支持的 model invocation policy。 */
    const asset = await assets.fromBytes({
      bytes: markdownWithFrontmatter({
        'name': skill.id,
        'description': skill.description,
        'disable-model-invocation': !skill.invocation.model,
      }, skill.body),
      origin: { operation: 'component-skill', subjects: [`skill:${skill.id}`] },
    });
    output.push(Object.freeze({ path: `skills/${skill.id}/SKILL.md`, asset }));
    for (const auxiliary of skill.auxiliaryFiles)
      output.push(Object.freeze({ path: `skills/${skill.id}/${auxiliary.path}`, asset: auxiliary.asset }));
    compatibility.push(Object.freeze({
      subject: `skill:${skill.id}`,
      capability: 'component',
      level: 'native',
      reason: 'Cursor supports native Plugin Agent Skills.',
    }));
    if (!skill.invocation.user) {
      compatibility.push(Object.freeze({
        subject: `skill:${skill.id}`,
        capability: 'invocation.user',
        level: 'degraded',
        transformation: 'explicit-invocation-remains',
        reason: 'Cursor Skill metadata cannot disable explicit user invocation.',
      }));
    }
  }
  for (const agent of project.agents) {
    /** readonly 只在全部 portable capabilities 都可精确表达时生成。 */
    const readonly = isReadOnly(agent.capabilities);
    /** Agent Markdown 使用 Cursor 原生 Subagent schema。 */
    const asset = await assets.fromBytes({
      bytes: renderCursorAgent({ id: agent.id, description: agent.description, body: agent.body, ...(readonly ? { readonly: true } : {}) }),
      origin: { operation: 'component-agent', subjects: [`agent:${agent.id}`] },
    });
    output.push(Object.freeze({ path: `agents/${agent.id}.md`, asset }));
    compatibility.push(Object.freeze({
      subject: `agent:${agent.id}`,
      capability: 'component',
      level: 'native',
      reason: 'Cursor supports native Plugin Subagents.',
    }));
    if (agent.model !== 'inherit') {
      compatibility.push(Object.freeze({
        subject: `agent:${agent.id}`,
        capability: 'agent.model',
        level: 'degraded',
        transformation: 'platform-default-model',
        reason: 'Cursor has no stable mapping for canonical abstract model classes.',
      }));
    }
    if (agent.capabilities.length > 0 && !readonly) {
      compatibility.push(Object.freeze({
        subject: `agent:${agent.id}`,
        capability: 'agent.capabilities',
        level: 'degraded',
        transformation: 'capability-boundary-omitted',
        reason: 'Cursor can express readonly but not every canonical capability combination.',
      }));
    }
  }
  return Object.freeze({ assets: Object.freeze(output), compatibility: Object.freeze(compatibility) });
}
