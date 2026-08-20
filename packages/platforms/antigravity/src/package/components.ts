import {
  markdownWithFrontmatter,
  type AssetService,
  type CanonicalProject,
  type CompatibilityInput,
  type DiagnosticService,
  type PackageAssetInput,
  type PlatformComponentValidationContext,
} from '@tokenroll/acplugin/sdk';

/** Antigravity 当前不开放未经官方文档确认的 Component 专属字段。 */
const COMPONENT_FIELDS = new Set<string>();

/** 最终 Antigravity Skill 命名空间中的一项规范来源。 */
interface GeneratedSkillIdentity {
  readonly id: string;
  readonly subject: string;
}

/** Antigravity base Package 的 Component 转换结果。 */
export interface AntigravityComponentPackage {
  readonly assets: readonly PackageAssetInput[];
  readonly compatibility: readonly CompatibilityInput[];
}

/** 校验 Antigravity Component namespace，不允许 raw Frontmatter 逃逸。 */
export function validateAntigravityComponent(context: PlatformComponentValidationContext): void {
  /** fields 是 Scanner 已复制冻结的平台 namespace。 */
  const fields = context.component.platforms.antigravity ?? {};
  for (const field of Object.keys(fields)) {
    if (!COMPONENT_FIELDS.has(field)) {
      context.diagnostics.report({
        code: 'ANTIGRAVITY_COMPONENT_FIELD_UNKNOWN',
        severity: 'error',
        message: `Unknown Antigravity ${context.component.kind} field "${field}".`,
        fieldPath: ['platforms', 'antigravity', field],
      });
    }
  }
}

/** @returns 全部 canonical Component 最终占用的 Antigravity Skill identity。 */
function generatedSkillIdentities(project: CanonicalProject): readonly GeneratedSkillIdentity[] {
  return Object.freeze([
    ...project.skills.map(skill => Object.freeze({ id: skill.id, subject: `skill:${skill.id}` })),
    ...project.commands.map(command => Object.freeze({ id: `command-${command.id}`, subject: `command:${command.id}` })),
    ...project.agents.map(agent => Object.freeze({ id: `agent-${agent.id}`, subject: `agent:${agent.id}` })),
  ]);
}

/** 在任何 Asset 签发前拒绝 native/fallback Skill ID 的 exact、case 或 NFC 冲突。 */
export function validateGeneratedSkillIds(project: CanonicalProject, diagnostics: DiagnosticService): boolean {
  /** owners 使用最严格目标文件系统的 NFC/case-fold key。 */
  const owners = new Map<string, GeneratedSkillIdentity>();
  /** valid 允许调用方在命名空间有歧义时完全跳过 Asset 创建。 */
  let valid = true;
  for (const identity of generatedSkillIdentities(project)) {
    /** canonical ID 当前为 ASCII，显式规范化仍固定未来来源的边界。 */
    const key = identity.id.normalize('NFC').toLowerCase();
    /** owner 是先占用相同最终 ID 的规范来源。 */
    const owner = owners.get(key);
    if (owner !== undefined) {
      valid = false;
      diagnostics.report({
        code: 'ANTIGRAVITY_GENERATED_SKILL_ID_COLLISION',
        severity: 'error',
        message: `${owner.subject} and ${identity.subject} both generate Antigravity Skill ID "${identity.id}".`,
        hint: 'Rename one canonical Component so every native and fallback Skill ID is unique.',
      });
    } else {
      owners.set(key, identity);
    }
  }
  return valid;
}

/** 把 canonical Commands、Skills 与 Agents 转换为 Antigravity Skills。 */
export async function createAntigravityComponents(
  project: CanonicalProject,
  assets: AssetService,
): Promise<AntigravityComponentPackage> {
  /** output 只包含 Platform 自有 bytes 和 Core 授权的 Skill auxiliary refs。 */
  const output: PackageAssetInput[] = [];
  /** compatibility 精确描述每个 Component 的原生或 fallback 语义。 */
  const compatibility: CompatibilityInput[] = [];
  for (const skill of project.skills) {
    /** Skill 主文档使用 Antigravity 原生 Skill 结构。 */
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
      reason: 'Antigravity Plugins support Skills natively.',
    }));
    if (!skill.invocation.user || !skill.invocation.model) {
      compatibility.push(Object.freeze({
        subject: `skill:${skill.id}`,
        capability: 'invocation',
        level: 'degraded',
        transformation: 'invocation-switches-omitted',
        reason: 'Antigravity has no verified independent user and model invocation switches.',
      }));
    }
  }
  for (const command of project.commands) {
    /** Command 使用固定前缀进入统一 Skill 命名空间。 */
    const id = `command-${command.id}`;
    /** 显式 Skill 通过调用指引保留 Command 参数语义。 */
    const asset = await assets.fromBytes({
      bytes: markdownWithFrontmatter(
        { name: id, description: command.description },
        command.body.replaceAll('{{arguments}}', 'the arguments supplied with this explicit invocation'),
      ),
      origin: { operation: 'component-command', subjects: [`command:${command.id}`] },
    });
    output.push(Object.freeze({ path: `skills/${id}/SKILL.md`, asset }));
    compatibility.push(Object.freeze({
      subject: `command:${command.id}`,
      capability: 'component',
      level: 'transform',
      transformation: `explicit-skill:${id}`.toLowerCase(),
      reason: 'Antigravity Plugins expose reusable prompt workflows as Skills.',
    }));
    if (command.body.includes('{{arguments}}')) {
      compatibility.push(Object.freeze({
        subject: `command:${command.id}`,
        capability: 'arguments',
        level: 'transform',
        transformation: 'explicit-invocation-guidance',
        reason: 'Antigravity Skills receive arguments through the invoking prompt.',
      }));
    }
    if (command.argumentHint !== undefined) {
      compatibility.push(Object.freeze({
        subject: `command:${command.id}`,
        capability: 'argument-hint',
        level: 'degraded',
        transformation: 'argument-hint-omitted',
        reason: 'Antigravity Skills have no verified Command argument hint field.',
      }));
    }
  }
  for (const agent of project.agents) {
    /** Agent 使用固定前缀进入统一 Skill 命名空间。 */
    const id = `agent-${agent.id}`;
    /** guidance 明确标注平台无法强制的模型和 capability 意图。 */
    const guidance = [
      agent.body,
      '',
      `Intended model class: ${agent.model}.`,
      `Intended capabilities: ${agent.capabilities.join(', ') || 'none declared'}.`,
      'Use this Skill as role guidance; Antigravity does not register it as a dedicated Agent.',
    ].join('\n');
    /** fallback Skill 由 Platform owner 签发。 */
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
        reason: 'Antigravity Plugin documentation does not define installable custom Agents.',
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
