import {
  bytesArtifact,
  markdownWithFrontmatter,
  type ArtifactInput,
  type PlatformComponentValidationContext,
  type PlatformGenerateContext,
  type PlatformPrepareContext,
  type PluginProject,
} from '@tokenroll/acplugin';

/** Pi 1.0 暂不开放未经官方 package 契约确认的 Component 专属字段。 */
const COMPONENT_FIELDS = new Set<string>();

/** 最终 Pi Skill 命名空间中的一项规范来源。 */
interface GeneratedSkillIdentity {
  /** 最终目录 ID。 */
  readonly id: string;
  /** 用于诊断的规范 Component 身份。 */
  readonly subject: string;
}

/**
 * 校验 Pi Component 专属字段，阻止任意 Frontmatter 透传。
 *
 * @param context Core 规范化并冻结后的字段校验上下文。
 */
export function validatePiComponentFields(context: PlatformComponentValidationContext): void {
  for (const field of Object.keys(context.fields)) {
    if (!COMPONENT_FIELDS.has(field)) {
      context.reportDiagnostic({
        code: 'PI_COMPONENT_FIELD_UNKNOWN',
        severity: 'error',
        message: `Unknown Pi ${context.component.kind} field "${field}".`,
        fieldPath: ['platforms', 'pi', field],
      });
    }
  }
}

/**
 * 列出全部规范 Skill 与 Agent fallback 最终占用的 Pi Skill ID。
 *
 * @param project 已完成规范扫描的 Plugin 工程。
 * @returns 保持 Component 类型与扫描顺序的生成身份。
 */
function generatedSkillIdentities(project: PluginProject): readonly GeneratedSkillIdentity[] {
  return [
    ...project.skills.map(skill => ({ id: skill.id, subject: `skill:${skill.id}` })),
    ...project.agents.map(agent => ({ id: `agent-${agent.id}`, subject: `agent:${agent.id}` })),
  ];
}

/**
 * 在 prepare 阶段拒绝规范 ID 与 Agent fallback ID 冲突。
 *
 * @param context Pi Platform prepare 上下文。
 */
export function validateGeneratedSkillIds(context: PlatformPrepareContext): void {
  /** 已经占用最终 ID 的首个规范 Component。 */
  const owners = new Map<string, GeneratedSkillIdentity>();
  for (const identity of generatedSkillIdentities(context.project)) {
    /** npm package 在跨平台文件系统上采用大小写不敏感冲突规则。 */
    const key = identity.id.toLocaleLowerCase('en-US');
    /** 已经占用同一最终 ID 的来源。 */
    const owner = owners.get(key);
    if (owner !== undefined) {
      context.reportDiagnostic({
        code: 'PI_GENERATED_SKILL_ID_COLLISION',
        severity: 'error',
        message: `${owner.subject} and ${identity.subject} both generate Pi Skill ID "${identity.id}".`,
        hint: 'Rename one canonical Component so every native and fallback Skill ID is unique.',
      });
    } else {
      owners.set(key, identity);
    }
  }
}

/**
 * 把规范 Commands、Skills 与 Agents 转换为 Pi package 资源。
 *
 * @param context Platform generateBundle 生命周期上下文。
 * @returns 确定排序且尚未进入 DeliveryUnit Registry 的 Artifact 输入。
 */
export function generateComponentArtifacts(context: PlatformGenerateContext): ArtifactInput[] {
  /** 当前 Platform 累计生成的 Component Artifact。 */
  const artifacts: ArtifactInput[] = [];
  for (const command of context.project.commands) {
    artifacts.push(bytesArtifact(`prompts/${command.id}.md`, markdownWithFrontmatter({
      'description': command.description,
      'argument-hint': command.argumentHint,
    }, command.body.replaceAll('{{arguments}}', '$ARGUMENTS'))));
    context.reportCompatibility({
      subject: `command:${command.id}`,
      capability: 'component',
      level: 'transform',
      transformation: `Prompt Template prompts/${command.id}.md`,
      reason: 'Pi packages represent reusable slash prompts as Prompt Templates.',
    });
    if (command.argumentHint !== undefined) {
      context.reportCompatibility({
        subject: `command:${command.id}`,
        capability: 'argumentHint',
        level: 'native',
        reason: 'Pi Prompt Templates support argument-hint and $ARGUMENTS.',
      });
    }
  }

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
      reason: 'Pi packages support Agent Skills natively.',
    });
    if (!skill.invocation.user || !skill.invocation.model) {
      context.reportCompatibility({
        subject: `skill:${skill.id}`,
        capability: 'invocation',
        level: 'degraded',
        transformation: 'The Skill remains available to both users and the model.',
        reason: 'Pi has no verified independent user/model invocation switches for Skills.',
      });
    }
  }

  for (const agent of context.project.agents) {
    /** Agent 使用固定前缀进入 Pi Skill 命名空间。 */
    const id = `agent-${agent.id}`;
    /** 降级正文明确区分作者意图与平台无法强制的运行约束。 */
    const guidance = [
      agent.body,
      '',
      `Intended model class: ${agent.model}.`,
      `Intended capabilities: ${agent.capabilities.join(', ') || 'none declared'}.`,
      'Use this Skill as role guidance; Pi does not register it as a dedicated Agent.',
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
      reason: 'Pi packages do not define a first-class static custom Agent resource.',
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

/**
 * 判断 Pi package 是否需要声明 skills 目录。
 *
 * @param project 已完成扫描的规范工程。
 * @returns 存在原生 Skill 或 Agent fallback 时返回 true。
 */
export function hasGeneratedSkills(project: PluginProject): boolean {
  return project.skills.length + project.agents.length > 0;
}
