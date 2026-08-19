import {
  markdownWithFrontmatter,
  stableYaml,
  type AgentComponent,
  type AssetService,
  type CanonicalProject,
  type CommandComponent,
  type CompatibilityInput,
  type DiagnosticService,
  type PackageAssetInput,
  type PlatformComponentValidationContext,
  type SkillComponent,
} from '@tokenroll/acplugin/sdk';
import { CODEX_BRAND_COLOR_PATTERN, CODEX_SKILL_PRODUCTS } from './protocol.js';

/** Codex Skill `agents/openai.yaml` 允许配置的 Component 专属字段。 */
const COMPONENT_FIELDS = new Set([
  'displayName', 'shortDescription', 'iconSmall', 'iconLarge', 'brandColor', 'defaultPrompt', 'products',
]);

/** Codex Skill 元数据允许声明的产品范围。 */
const PRODUCTS = new Set<string>(CODEX_SKILL_PRODUCTS);

/** 三类 canonical Component 的联合视图。 */
type Component = CommandComponent | SkillComponent | AgentComponent;

/** 把未知 JSON 字段收窄为便于逐项验证的对象。 */
type UnknownFields = Readonly<Record<string, unknown>>;

/** 生成后的 Codex Skill ID 与规范来源。 */
interface GeneratedSkillIdentity {
  readonly id: string;
  readonly subject: string;
}

/** Codex Skill 的 `agents/openai.yaml` 结构。 */
interface OpenAiSkillMetadata {
  readonly interface: {
    readonly display_name: string;
    readonly short_description: string;
    readonly icon_small?: string;
    readonly icon_large?: string;
    readonly brand_color?: string;
    readonly default_prompt?: string;
  };
  readonly policy?: {
    readonly products?: readonly ('CHAT' | 'CODEX')[];
    readonly allow_implicit_invocation?: false;
  };
}

/** Codex base Package 的 Component 转换结果。 */
export interface CodexComponentPackage {
  readonly assets: readonly PackageAssetInput[];
  readonly compatibility: readonly CompatibilityInput[];
}

/** @returns 值是否为非空字符串。 */
function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/** @returns 值是否为不含重复项的非空字符串数组。 */
function isUniqueStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every(isNonEmptyString) && new Set(value).size === value.length;
}

/** @returns Skill 内部资源路径是否安全。 */
function isSafeSkillPath(value: string): boolean {
  if (!value.startsWith('./') || value.includes('\\') || value.includes('\0'))
    return false;
  /** relative 是去掉协议前缀后用于拒绝父目录和空路径的片段。 */
  const relative = value.slice(2);
  return relative.length > 0 && relative !== '..' && !relative.startsWith('../') && !relative.split('/').includes('..');
}

/** 提交带 canonical Frontmatter 路径的 Codex 字段错误。 */
function fieldError(context: PlatformComponentValidationContext, field: string, message: string): void {
  context.diagnostics.report({
    code: 'CODEX_COMPONENT_FIELD_INVALID', severity: 'error', message,
    fieldPath: ['platforms', 'codex', field],
  });
}

/** 校验 Component 的 Codex Skill 展示字段，不允许 raw schema 逃逸。 */
export function validateCodexComponent(context: PlatformComponentValidationContext): void {
  /** fields 是 Scanner 已复制冻结的 Codex namespace。 */
  const fields: UnknownFields = context.component.platforms.codex ?? {};
  for (const field of Object.keys(fields)) {
    if (!COMPONENT_FIELDS.has(field)) {
      context.diagnostics.report({
        code: 'CODEX_COMPONENT_FIELD_UNKNOWN', severity: 'error',
        message: `Unknown Codex ${context.component.kind} field "${field}".`,
        fieldPath: ['platforms', 'codex', field],
      });
    }
  }
  for (const field of ['displayName', 'shortDescription', 'defaultPrompt']) {
    if (fields[field] !== undefined && !isNonEmptyString(fields[field]))
      fieldError(context, field, `${field} must be a non-empty string.`);
  }
  for (const field of ['iconSmall', 'iconLarge']) {
    if (fields[field] !== undefined && (!isNonEmptyString(fields[field]) || !isSafeSkillPath(fields[field])))
      fieldError(context, field, `${field} must start with ./ and stay inside the generated Skill root.`);
  }
  if (fields.brandColor !== undefined
    && (!isNonEmptyString(fields.brandColor) || !CODEX_BRAND_COLOR_PATTERN.test(fields.brandColor))) {
    fieldError(context, 'brandColor', 'brandColor must be a six-digit hexadecimal color.');
  }
  if (fields.products !== undefined
    && (!isUniqueStringArray(fields.products) || fields.products.some(product => !PRODUCTS.has(product)))) {
    fieldError(context, 'products', 'products must contain CHAT, CODEX, or both without duplicates.');
  }
}

/** @returns 当前 Component 已验证的 Codex namespace。 */
function codexFields(component: Component): UnknownFields {
  return component.platforms.codex ?? {};
}

/** @returns canonical Command 的默认 plugin-prefixed Codex Skill ID。 */
export function commandSkillId(project: CanonicalProject, commandId: string): string {
  return `${project.metadata.name}-${commandId}`;
}

/** @returns 全部 canonical Component 最终占用的 Codex Skill identity。 */
function generatedSkillIdentities(project: CanonicalProject): readonly GeneratedSkillIdentity[] {
  return Object.freeze([
    ...project.skills.map(skill => Object.freeze({ id: skill.id, subject: `skill:${skill.id}` })),
    ...project.commands.map(command => Object.freeze({
      id: commandSkillId(project, command.id), subject: `command:${command.id}`,
    })),
    ...project.agents.map(agent => Object.freeze({ id: `agent-${agent.id}`, subject: `agent:${agent.id}` })),
  ]);
}

/** 在任何 Asset 签发前拒绝 generated Skill ID 的 exact/case/NFC 冲突。 */
export function validateGeneratedSkillIds(project: CanonicalProject, diagnostics: DiagnosticService): boolean {
  /** owners 使用最严格目标文件系统的 NFC/case-fold key。 */
  const owners = new Map<string, GeneratedSkillIdentity>();
  /** valid 允许调用方在任何 bytes Asset 生成前中止转换。 */
  let valid = true;
  for (const identity of generatedSkillIdentities(project)) {
    /** key 不依赖 locale，canonical ID 本身只允许 ASCII lowercase kebab-case。 */
    const key = identity.id.normalize('NFC').toLowerCase();
    /** owner 是先占用相同最终 ID 的规范来源。 */
    const owner = owners.get(key);
    if (owner !== undefined) {
      valid = false;
      diagnostics.report({
        code: 'CODEX_GENERATED_SKILL_ID_COLLISION', severity: 'error',
        message: `${owner.subject} and ${identity.subject} both generate Codex Skill ID "${identity.id}".`,
        hint: 'Rename one canonical Component so every native and generated Skill ID is unique.',
      });
    } else {
      owners.set(key, identity);
    }
  }
  return valid;
}

/** @returns 当前 Component 的完整 Codex Skill interface/policy，或无需生成时返回 undefined。 */
function skillMetadata(
  component: Component,
  generatedId: string,
  allowImplicitInvocation: boolean,
): OpenAiSkillMetadata | undefined {
  /** fields 已经通过 validateComponent 检查。 */
  const fields = codexFields(component);
  if (allowImplicitInvocation && Object.keys(fields).length === 0)
    return undefined;
  /** policy 仅在产品范围或隐式调用限制实际存在时生成。 */
  const policy = fields.products !== undefined || !allowImplicitInvocation
    ? {
        ...(fields.products === undefined ? {} : { products: fields.products as readonly ('CHAT' | 'CODEX')[] }),
        ...(allowImplicitInvocation ? {} : { allow_implicit_invocation: false as const }),
      }
    : undefined;
  return {
    interface: {
      display_name: fields.displayName as string | undefined ?? generatedId,
      short_description: fields.shortDescription as string | undefined ?? component.description,
      ...(fields.iconSmall === undefined ? {} : { icon_small: fields.iconSmall as string }),
      ...(fields.iconLarge === undefined ? {} : { icon_large: fields.iconLarge as string }),
      ...(fields.brandColor === undefined ? {} : { brand_color: fields.brandColor as string }),
      ...(fields.defaultPrompt === undefined ? {} : { default_prompt: fields.defaultPrompt as string }),
    },
    ...(policy === undefined ? {} : { policy }),
  };
}

/** 如有需要，为一个 Skill 创建相邻 `agents/openai.yaml` Asset。 */
async function appendSkillMetadata(
  output: PackageAssetInput[],
  assets: AssetService,
  component: Component,
  generatedId: string,
  allowImplicitInvocation: boolean,
): Promise<void> {
  /** metadata 遵守 Codex interface 必填字段和 invocation policy。 */
  const metadata = skillMetadata(component, generatedId, allowImplicitInvocation);
  if (metadata === undefined)
    return;
  /** asset 由当前 Platform owner 签发并携带精确 Component provenance。 */
  const asset = await assets.fromBytes({
    bytes: `${stableYaml(metadata)}\n`,
    origin: { operation: 'skill-metadata', subjects: [`${component.kind}:${component.id}`] },
  });
  output.push(Object.freeze({ path: `skills/${generatedId}/agents/openai.yaml`, asset }));
}

/** 把 Commands、Skills、Agents 转为 Codex Skills 并返回完整兼容性。 */
export async function createCodexComponents(
  project: CanonicalProject,
  assets: AssetService,
): Promise<CodexComponentPackage> {
  /** output 保存 Platform-owned bytes 和被 Core 授权的 Skill auxiliary refs。 */
  const output: PackageAssetInput[] = [];
  /** compatibility 精确覆盖每个 canonical Component 及实际附加语义。 */
  const compatibility: CompatibilityInput[] = [];
  for (const skill of project.skills) {
    /** manifest 是原生 Skill 主文档。 */
    const manifest = await assets.fromBytes({
      bytes: markdownWithFrontmatter({ name: skill.id, description: skill.description }, skill.body),
      origin: { operation: 'component-skill', subjects: [`skill:${skill.id}`] },
    });
    output.push(Object.freeze({ path: `skills/${skill.id}/SKILL.md`, asset: manifest }));
    await appendSkillMetadata(output, assets, skill, skill.id, skill.invocation.model);
    for (const auxiliary of skill.auxiliaryFiles)
      output.push(Object.freeze({ path: `skills/${skill.id}/${auxiliary.path}`, asset: auxiliary.asset }));
    compatibility.push(Object.freeze({
      subject: `skill:${skill.id}`, capability: 'component', level: 'native',
      reason: 'Codex supports Plugin Skills natively.',
    }));
    if (!skill.invocation.user) {
      compatibility.push(Object.freeze({
        subject: `skill:${skill.id}`, capability: 'invocation.user', level: 'degraded',
        transformation: 'explicit-invocation-remains',
        reason: 'Codex Skill metadata cannot disable explicit user invocation.',
      }));
    }
  }

  for (const command of project.commands) {
    /** id 默认且始终包含 Plugin name，避免跨 Plugin generated Skill 冲突。 */
    const id = commandSkillId(project, command.id);
    /** manifest 将 Command 显式调用语义转换为 Skill 指引。 */
    const manifest = await assets.fromBytes({
      bytes: markdownWithFrontmatter({ name: id, description: command.description },
        command.body.replaceAll('{{arguments}}', 'the arguments supplied with this explicit invocation')),
      origin: { operation: 'component-command', subjects: [`command:${command.id}`] },
    });
    output.push(Object.freeze({ path: `skills/${id}/SKILL.md`, asset: manifest }));
    await appendSkillMetadata(output, assets, command, id, false);
    compatibility.push(Object.freeze({
      subject: `command:${command.id}`, capability: 'component', level: 'transform',
      transformation: `explicit-skill:${id}`,
      reason: 'Codex represents Commands as explicitly invoked Skills.',
    }));
    if (command.body.includes('{{arguments}}')) {
      compatibility.push(Object.freeze({
        subject: `command:${command.id}`, capability: 'arguments', level: 'transform',
        transformation: 'explicit-invocation-guidance',
        reason: 'Codex Skills receive arguments through the invoking prompt rather than a Command placeholder.',
      }));
    }
    if (command.argumentHint !== undefined) {
      compatibility.push(Object.freeze({
        subject: `command:${command.id}`, capability: 'argument-hint', level: 'degraded',
        transformation: 'argument-hint-omitted',
        reason: 'Codex Skills do not expose the Command argument hint field.',
      }));
    }
  }

  for (const agent of project.agents) {
    /** id 使用固定 Agent 前缀避免与 native Skills 占用同一命名空间。 */
    const id = `agent-${agent.id}`;
    /** guidance 明确保留不可强制执行的模型和 capability 作者意图。 */
    const guidance = [
      agent.body,
      '',
      `Intended model class: ${agent.model}.`,
      `Intended capabilities: ${agent.capabilities.join(', ') || 'none declared'}.`,
      'When delegation is available, use a focused subagent with this role. These settings are guidance, not enforced registration.',
    ].join('\n');
    /** manifest 是 guidance-only fallback Skill。 */
    const manifest = await assets.fromBytes({
      bytes: markdownWithFrontmatter({ name: id, description: agent.description }, guidance),
      origin: { operation: 'component-agent', subjects: [`agent:${agent.id}`] },
    });
    output.push(Object.freeze({ path: `skills/${id}/SKILL.md`, asset: manifest }));
    await appendSkillMetadata(output, assets, agent, id, true);
    compatibility.push(
      Object.freeze({
        subject: `agent:${agent.id}`, capability: 'component', level: 'degraded',
        transformation: `guidance-skill:${id}`,
        reason: 'Codex installable Plugins cannot register custom Agents.',
      }),
      Object.freeze({
        subject: `agent:${agent.id}`, capability: 'agent.model', level: 'degraded',
        transformation: 'model-guidance',
        reason: 'A fallback Skill cannot enforce an Agent model selection.',
      }),
    );
    if (agent.capabilities.length > 0) {
      compatibility.push(Object.freeze({
        subject: `agent:${agent.id}`, capability: 'agent.capabilities', level: 'degraded',
        transformation: 'capability-guidance',
        reason: 'A fallback Skill cannot enforce an Agent tool capability boundary.',
      }));
    }
  }
  return Object.freeze({ assets: Object.freeze(output), compatibility: Object.freeze(compatibility) });
}

/** @returns 工程是否至少生成一个 Codex Skill。 */
export function hasGeneratedSkills(project: CanonicalProject): boolean {
  return project.skills.length + project.commands.length + project.agents.length > 0;
}
