import {
  bytesArtifact,
  markdownWithFrontmatter,
  type ArtifactInput,
  type PlatformComponentValidationContext,
  type PlatformGenerateContext,
  type PlatformPrepareContext,
  type PluginProject,
} from '@acplugin/core';

/** Antigravity 1.0 暂不开放未经官方文档确认的 Component 专属字段。 */
const COMPONENT_FIELDS = new Set<string>();

/** 最终 Antigravity Skill 命名空间中的一项规范来源。 */
interface GeneratedSkillIdentity {
  /** 最终目录 ID。 */
  readonly id: string;
  /** 用于诊断的规范 Component 身份。 */
  readonly subject: string;
}

/**
 * 校验 Antigravity Component 专属字段，阻止 raw Frontmatter 逃逸。
 *
 * @param context Core 规范化并冻结后的字段校验上下文。
 */
export function validateAntigravityComponentFields(context: PlatformComponentValidationContext): void {
  for (const field of Object.keys(context.fields)) {
    if (!COMPONENT_FIELDS.has(field)) {
      context.reportDiagnostic({
        code: 'ANTIGRAVITY_COMPONENT_FIELD_UNKNOWN',
        severity: 'error',
        message: `Unknown Antigravity ${context.component.kind} field "${field}".`,
        fieldPath: ['platforms', 'antigravity', field],
      });
    }
  }
}

/**
 * 列出全部规范 Component 最终占用的 Antigravity Skill ID。
 *
 * @param project 已完成规范扫描的 Plugin 工程。
 * @returns 保持 Component 类型与扫描顺序的生成身份。
 */
function generatedSkillIdentities(project: PluginProject): readonly GeneratedSkillIdentity[] {
  return [
    ...project.skills.map(skill => ({ id: skill.id, subject: `skill:${skill.id}` })),
    ...project.commands.map(command => ({ id: `command-${command.id}`, subject: `command:${command.id}` })),
    ...project.agents.map(agent => ({ id: `agent-${agent.id}`, subject: `agent:${agent.id}` })),
  ];
}

/**
 * 在 prepare 阶段拒绝规范 ID 与 fallback ID 的大小写不敏感冲突。
 *
 * @param context Antigravity Platform prepare 上下文。
 */
export function validateGeneratedSkillIds(context: PlatformPrepareContext): void {
  /** 已经占用最终 ID 的首个规范 Component。 */
  const owners = new Map<string, GeneratedSkillIdentity>();
  for (const identity of generatedSkillIdentities(context.project)) {
    /** 安装表面采用大小写不敏感的稳定冲突规则。 */
    const key = identity.id.toLocaleLowerCase('en-US');
    /** 已经占用同一最终 ID 的来源。 */
    const owner = owners.get(key);
    if (owner !== undefined) {
      context.reportDiagnostic({
        code: 'ANTIGRAVITY_GENERATED_SKILL_ID_COLLISION',
        severity: 'error',
        message: `${owner.subject} and ${identity.subject} both generate Antigravity Skill ID "${identity.id}".`,
        hint: 'Rename one canonical Component so every native and fallback Skill ID is unique.',
      });
    } else {
      owners.set(key, identity);
    }
  }
}

/**
 * 把规范 Commands、Skills 与 Agents 转换为 Antigravity Skills。
 *
 * @param context Platform generateBundle 生命周期上下文。
 * @returns 确定排序且尚未进入 DeliveryUnit Registry 的 Artifact 输入。
 */
export function generateComponentArtifacts(context: PlatformGenerateContext): ArtifactInput[] {
  /** 当前 Platform 累计生成的 Component Artifact。 */
  const artifacts: ArtifactInput[] = [];
  for (const skill of context.project.skills) {
    artifacts.push(bytesArtifact(`skills/${skill.id}/SKILL.md`, markdownWithFrontmatter({
      name: skill.id,
      description: skill.description,
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
      reason: 'Antigravity plugins support Skills natively.',
    });
    if (!skill.invocation.user || !skill.invocation.model) {
      context.reportCompatibility({
        subject: `skill:${skill.id}`,
        capability: 'invocation',
        level: 'degraded',
        transformation: 'The Skill remains available to both users and the model.',
        reason: 'Antigravity has no verified independent user/model invocation switches.',
      });
    }
  }

  for (const command of context.project.commands) {
    /** Command 使用固定前缀进入统一 Skill 命名空间。 */
    const id = `command-${command.id}`;
    artifacts.push(bytesArtifact(`skills/${id}/SKILL.md`, markdownWithFrontmatter({
      name: id,
      description: command.description,
    }, command.body.replaceAll('{{arguments}}', 'the arguments supplied with this explicit invocation'))));
    context.reportCompatibility({
      subject: `command:${command.id}`,
      capability: 'component',
      level: 'transform',
      transformation: `Explicit Skill ${id}`,
      reason: 'Antigravity plugins expose reusable prompt workflows as Skills.',
    });
    if (command.argumentHint !== undefined) {
      context.reportCompatibility({
        subject: `command:${command.id}`,
        capability: 'argumentHint',
        level: 'degraded',
        transformation: `Explicit Skill ${id} without argument hint UI`,
        reason: 'Antigravity Skills have no verified Command argument hint field.',
      });
    }
  }

  for (const agent of context.project.agents) {
    /** Agent 使用固定前缀进入统一 Skill 命名空间。 */
    const id = `agent-${agent.id}`;
    /** 降级正文明确区分作者意图与平台无法强制的运行约束。 */
    const guidance = [
      agent.body,
      '',
      `Intended model class: ${agent.model}.`,
      `Intended capabilities: ${agent.capabilities.join(', ') || 'none declared'}.`,
      'Use this Skill as role guidance; Antigravity does not register it as a dedicated Agent.',
    ].join('\n');
    artifacts.push(bytesArtifact(`skills/${id}/SKILL.md`, markdownWithFrontmatter({
      name: id,
      description: agent.description,
    }, guidance)));
    context.reportCompatibility({
      subject: `agent:${agent.id}`,
      capability: 'component',
      level: 'degraded',
      transformation: `Guidance-only Skill ${id}`,
      reason: 'Antigravity plugin documentation does not define installable custom Agents.',
    });
    context.reportCompatibility({
      subject: `agent:${agent.id}`,
      capability: 'agent.model',
      level: 'degraded',
      transformation: 'The intended model class is preserved as guidance text.',
      reason: 'A fallback Skill cannot enforce an Agent model selection.',
    });
    if (agent.capabilities.length > 0) {
      context.reportCompatibility({
        subject: `agent:${agent.id}`,
        capability: 'agent.capabilities',
        level: 'degraded',
        transformation: 'The intended capabilities are preserved as guidance text.',
        reason: 'A fallback Skill cannot enforce an Agent capability boundary.',
      });
    }
  }
  return artifacts;
}
