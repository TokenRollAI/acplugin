import {
  markdownWithFrontmatter,
  type AssetService,
  type CanonicalProject,
  type CompatibilityInput,
  type DiagnosticService,
  type PackageAssetInput,
  type PlatformComponentValidationContext,
} from '@tokenroll/acplugin/sdk';

/** Pi 当前不开放未经官方文档确认的 Component 专属字段。 */
const COMPONENT_FIELDS = new Set<string>();

/** 最终 Pi Skill 命名空间中的一个 canonical owner。 */
interface GeneratedSkillIdentity {
  readonly id: string;
  readonly subject: string;
}

/** Pi base Package 的 Component 转换结果。 */
export interface PiComponentPackage {
  readonly assets: readonly PackageAssetInput[];
  readonly compatibility: readonly CompatibilityInput[];
}

/** 校验 Pi Component namespace，不允许 raw Frontmatter 逃逸。 */
export function validatePiComponent(context: PlatformComponentValidationContext): void {
  /** fields 是 Scanner 已复制冻结的 Pi namespace。 */
  const fields = context.component.platforms.pi ?? {};
  for (const field of Object.keys(fields)) {
    if (!COMPONENT_FIELDS.has(field)) {
      context.diagnostics.report({
        code: 'PI_COMPONENT_FIELD_UNKNOWN',
        severity: 'error',
        message: `Unknown Pi ${context.component.kind} field "${field}".`,
        fieldPath: ['platforms', 'pi', field],
      });
    }
  }
}

/** @returns 全部 native/fallback Skill 的最终身份。 */
function generatedSkillIdentities(project: CanonicalProject): readonly GeneratedSkillIdentity[] {
  return Object.freeze([
    ...project.skills.map(skill => Object.freeze({ id: skill.id, subject: `skill:${skill.id}` })),
    ...project.agents.map(agent => Object.freeze({ id: `agent-${agent.id}`, subject: `agent:${agent.id}` })),
  ]);
}

/** 在任何 Asset 签发前拒绝最终 Skill ID 的 exact、case 或 NFC 冲突。 */
export function validateGeneratedSkillIds(project: CanonicalProject, diagnostics: DiagnosticService): boolean {
  /** owners 使用最严格目标文件系统的 NFC/case-fold key。 */
  const owners = new Map<string, GeneratedSkillIdentity>();
  /** valid 让调用方在 namespace 有歧义时跳过全部 Component Asset。 */
  let valid = true;
  for (const identity of generatedSkillIdentities(project)) {
    /** 显式规范化固定未来可能扩展的身份边界。 */
    const key = identity.id.normalize('NFC').toLowerCase();
    /** owner 是先占用相同最终 ID 的 canonical 来源。 */
    const owner = owners.get(key);
    if (owner !== undefined) {
      valid = false;
      diagnostics.report({
        code: 'PI_GENERATED_SKILL_ID_COLLISION',
        severity: 'error',
        message: `${owner.subject} and ${identity.subject} both generate Pi Skill ID "${identity.id}".`,
        hint: 'Rename one canonical Component so every native and fallback Skill ID is unique.',
      });
    } else {
      owners.set(key, identity);
    }
  }
  return valid;
}

/** 把 canonical Commands、Skills 与 Agents 转换为 Pi Prompt/Skill 资源。 */
export async function createPiComponents(
  project: CanonicalProject,
  assets: AssetService,
): Promise<PiComponentPackage> {
  /** output 只包含 Platform bytes 和 Scanner 授权的 Skill auxiliary refs。 */
  const output: PackageAssetInput[] = [];
  /** compatibility 精确描述每个 canonical Component 的交付语义。 */
  const compatibility: CompatibilityInput[] = [];
  for (const command of project.commands) {
    /** Pi Prompt Template 使用原生参数 token 和受控 Frontmatter。 */
    const asset = await assets.fromBytes({
      bytes: markdownWithFrontmatter({
        description: command.description,
        ...(command.argumentHint === undefined ? {} : { 'argument-hint': command.argumentHint }),
      }, command.body.replaceAll('{{arguments}}', '$ARGUMENTS')),
      origin: { operation: 'component-command', subjects: [`command:${command.id}`] },
    });
    output.push(Object.freeze({ path: `prompts/${command.id}.md`, asset }));
    compatibility.push(Object.freeze({
      subject: `command:${command.id}`,
      capability: 'component',
      level: 'transform',
      transformation: `prompt-template:${command.id}`.toLowerCase(),
      reason: 'Pi packages represent reusable slash prompts as Prompt Templates.',
    }));
    if (command.body.includes('{{arguments}}')) {
      compatibility.push(Object.freeze({
        subject: `command:${command.id}`,
        capability: 'arguments',
        level: 'native',
        reason: 'Pi Prompt Templates support the $ARGUMENTS placeholder.',
      }));
    }
    if (command.argumentHint !== undefined) {
      compatibility.push(Object.freeze({
        subject: `command:${command.id}`,
        capability: 'argument-hint',
        level: 'native',
        reason: 'Pi Prompt Templates support argument-hint metadata.',
      }));
    }
  }
  for (const skill of project.skills) {
    /** Skill 主文档使用 Pi 原生 Agent Skill 结构。 */
    const asset = await assets.fromBytes({
      bytes: markdownWithFrontmatter({ name: skill.id, description: skill.description }, skill.body),
      origin: { operation: 'component-skill', subjects: [`skill:${skill.id}`] },
    });
    output.push(Object.freeze({ path: `skills/${skill.id}/SKILL.md`, asset }));
    for (const auxiliary of skill.auxiliaryFiles)
      output.push(Object.freeze({ path: `skills/${skill.id}/${auxiliary.path}`, asset: auxiliary.asset }));
    compatibility.push(Object.freeze({
      subject: `skill:${skill.id}`,
      capability: 'component',
      level: 'native',
      reason: 'Pi packages support Agent Skills natively.',
    }));
    if (!skill.invocation.user || !skill.invocation.model) {
      compatibility.push(Object.freeze({
        subject: `skill:${skill.id}`,
        capability: 'invocation',
        level: 'degraded',
        transformation: 'invocation-switches-omitted',
        reason: 'Pi has no verified independent user and model invocation switches for Skills.',
      }));
    }
  }
  for (const agent of project.agents) {
    /** Agent 使用固定前缀进入 Pi Skill namespace。 */
    const id = `agent-${agent.id}`;
    /** guidance 明确保留但不谎报模型和 capability 强制能力。 */
    const guidance = [
      agent.body,
      '',
      `Intended model class: ${agent.model}.`,
      `Intended capabilities: ${agent.capabilities.join(', ') || 'none declared'}.`,
      'Use this Skill as role guidance; Pi does not register it as a dedicated Agent.',
    ].join('\n');
    /** fallback Skill 由 Pi Platform owner 签发。 */
    const asset = await assets.fromBytes({
      bytes: markdownWithFrontmatter({ name: id, description: agent.description }, guidance),
      origin: { operation: 'component-agent', subjects: [`agent:${agent.id}`] },
    });
    output.push(Object.freeze({ path: `skills/${id}/SKILL.md`, asset }));
    compatibility.push(
      Object.freeze({
        subject: `agent:${agent.id}`,
        capability: 'component',
        level: 'degraded',
        transformation: `guidance-skill:${id}`.toLowerCase(),
        reason: 'Pi packages do not define a first-class static custom Agent resource.',
      }),
      Object.freeze({
        subject: `agent:${agent.id}`,
        capability: 'agent.model',
        level: 'degraded',
        transformation: 'model-guidance',
        reason: 'A fallback Skill cannot enforce an Agent model selection.',
      }),
    );
    if (agent.capabilities.length > 0) {
      compatibility.push(Object.freeze({
        subject: `agent:${agent.id}`,
        capability: 'agent.capabilities',
        level: 'degraded',
        transformation: 'capability-guidance',
        reason: 'A fallback Skill cannot enforce an Agent capability boundary.',
      }));
    }
  }
  return Object.freeze({ assets: Object.freeze(output), compatibility: Object.freeze(compatibility) });
}

/** @returns Package 是否需要声明 Skills discovery root。 */
export function hasGeneratedSkills(project: CanonicalProject): boolean {
  return project.skills.length + project.agents.length > 0;
}
