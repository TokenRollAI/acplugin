import {
  bytesArtifact,
  markdownWithFrontmatter,
  type ArtifactInput,
  type Component,
  type PlatformComponentValidationContext,
  type PlatformGenerateContext,
  type PluginProject,
} from '@acplugin/core';

/** Cursor 1.0 暂不开放未经独立 Schema 验证的 Component 专属字段。 */
const COMPONENT_FIELDS = new Set<string>();

/**
 * 校验 Cursor Component 专属字段，阻止 raw Frontmatter 绕过 Platform 所有权。
 *
 * @param context Core 规范化并冻结后的字段校验上下文。
 */
export function validateCursorComponentFields(context: PlatformComponentValidationContext): void {
  for (const field of Object.keys(context.fields)) {
    if (!COMPONENT_FIELDS.has(field)) {
      context.reportDiagnostic({
        code: 'CURSOR_COMPONENT_FIELD_UNKNOWN',
        severity: 'error',
        message: `Unknown Cursor ${context.component.kind} field "${field}".`,
        fieldPath: ['platforms', 'cursor', field],
      });
    }
  }
}

/**
 * 判断一组规范 Agent 能力是否可以收敛为 Cursor readonly。
 *
 * @param capabilities Agent 声明的规范能力。
 * @returns 只包含读取与搜索时返回 true。
 */
function isReadOnly(capabilities: readonly string[]): boolean {
  return capabilities.every(capability => capability === 'filesystem:read' || capability === 'search');
}

/**
 * 把规范 Commands、Skills 与 Agents 转换为 Cursor 原生文件。
 *
 * @param context Platform generateBundle 生命周期上下文。
 * @returns 确定排序且尚未进入 DeliveryUnit Registry 的 Artifact 输入。
 */
export function generateComponentArtifacts(context: PlatformGenerateContext): ArtifactInput[] {
  /** 当前 Platform 累计生成的 Component Artifact。 */
  const artifacts: ArtifactInput[] = [];
  for (const command of context.project.commands) {
    artifacts.push(bytesArtifact(`commands/${command.id}.md`, markdownWithFrontmatter({
      description: command.description,
    }, command.body.replaceAll('{{arguments}}', '$ARGUMENTS'))));
    context.reportCompatibility({
      subject: `command:${command.id}`,
      capability: 'component',
      level: 'native',
      reason: 'Cursor supports plugin Commands and the $ARGUMENTS placeholder.',
    });
    if (command.argumentHint !== undefined) {
      context.reportCompatibility({
        subject: `command:${command.id}`,
        capability: 'argumentHint',
        level: 'degraded',
        transformation: 'The Command remains callable without argument hint UI.',
        reason: 'Cursor Command metadata has no verified argument hint field.',
      });
    }
  }

  for (const skill of context.project.skills) {
    artifacts.push(bytesArtifact(`skills/${skill.id}/SKILL.md`, markdownWithFrontmatter({
      'name': skill.id,
      'description': skill.description,
      'disable-model-invocation': !skill.invocation.model,
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
      reason: 'Cursor supports plugin Agent Skills natively.',
    });
    if (!skill.invocation.user) {
      context.reportCompatibility({
        subject: `skill:${skill.id}`,
        capability: 'invocation.user',
        level: 'degraded',
        transformation: 'The Skill remains explicitly invocable.',
        reason: 'Cursor Skill metadata cannot disable explicit user invocation.',
      });
    }
  }

  for (const agent of context.project.agents) {
    /** 只有纯读取能力可以由 Cursor readonly 精确收敛。 */
    const readonly = isReadOnly(agent.capabilities);
    artifacts.push(bytesArtifact(`agents/${agent.id}.md`, markdownWithFrontmatter({
      name: agent.id,
      description: agent.description,
      ...(readonly ? { readonly: true } : {}),
    }, agent.body)));
    context.reportCompatibility({
      subject: `agent:${agent.id}`,
      capability: 'component',
      level: 'native',
      reason: 'Cursor supports plugin Subagents natively.',
    });
    if (agent.model !== 'inherit') {
      context.reportCompatibility({
        subject: `agent:${agent.id}`,
        capability: 'agent.model',
        level: 'degraded',
        transformation: 'Cursor chooses its current platform default model.',
        reason: 'acplugin does not hard-code a changing Cursor model ID for abstract model classes.',
      });
    }
    if (agent.capabilities.length > 0 && !readonly) {
      context.reportCompatibility({
        subject: `agent:${agent.id}`,
        capability: 'agent.capabilities',
        level: 'degraded',
        transformation: 'The Subagent remains available without an exact capability boundary.',
        reason: 'Cursor can express readonly but not every canonical capability combination.',
      });
    }
  }
  return artifacts;
}

/**
 * 判断工程是否包含某类 Component，以便清单只声明实际 Glob。
 *
 * @param project 已完成扫描和依赖图校验的规范工程。
 * @param kind 待检查的 Component 类型。
 * @returns 对应 Glob 需要进入 Cursor Manifest 时返回 true。
 */
export function hasComponents(project: PluginProject, kind: Component['kind']): boolean {
  if (kind === 'command')
    return project.commands.length > 0;
  if (kind === 'skill')
    return project.skills.length > 0;
  return project.agents.length > 0;
}
