import {
  bytesArtifact,
  markdownWithFrontmatter,
  stableYaml,
  type ArtifactInput,
  type Component,
  type PlatformComponentValidationContext,
  type PlatformGenerateContext,
  type PlatformPrepareContext,
  type PluginProject,
} from '@tokenroll/acplugin';
import { CODEX_BRAND_COLOR_PATTERN, CODEX_SKILL_PRODUCTS } from './protocol.js';

/** Codex Skill `agents/openai.yaml` 允许配置的 Component 专属字段。 */
const COMPONENT_FIELDS = new Set([
  'displayName', 'shortDescription', 'iconSmall', 'iconLarge', 'brandColor', 'defaultPrompt', 'products',
]);

/** Codex Skill 元数据允许声明的产品范围。 */
const PRODUCTS = new Set<string>(CODEX_SKILL_PRODUCTS);

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

/**
 * 判断未知值是否为非空字符串。
 *
 * @param value 待检查的平台字段。
 * @returns 可以写入 Codex 元数据时返回 true。
 */
function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * 判断未知值是否为不含重复项的非空字符串数组。
 *
 * @param value 待检查的平台字段。
 * @returns 字段满足确定性数组约束时返回 true。
 */
function isUniqueStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value)
    && value.every(isNonEmptyString)
    && new Set(value).size === value.length;
}

/**
 * 判断 Skill 内部资源路径是否安全。
 *
 * @param value `agents/openai.yaml` 中相对于 Skill 根的资源路径。
 * @returns 路径以 `./` 开头且不会逃逸 Skill 根时返回 true。
 */
function isSafeSkillPath(value: string): boolean {
  if (!value.startsWith('./') || value.includes('\\') || value.includes('\0'))
    return false;
  /** 去掉协议前缀后用于拒绝父目录和空路径的片段。 */
  const relative = value.slice(2);
  return relative.length > 0
    && relative !== '..'
    && !relative.startsWith('../')
    && !relative.split('/').includes('..');
}

/**
 * 提交带 Codex Component 字段位置的结构错误。
 *
 * @param context Core 提供的平台字段校验上下文。
 * @param field 当前错误字段。
 * @param message 面向插件作者的说明。
 */
function reportFieldError(
  context: PlatformComponentValidationContext,
  field: string,
  message: string,
): void {
  context.reportDiagnostic({
    code: 'CODEX_COMPONENT_FIELD_INVALID',
    severity: 'error',
    message,
    fieldPath: ['platforms', 'codex', field],
  });
}

/**
 * 校验 Codex Component 专属 Skill 展示字段。
 *
 * @param context Scanner 提供的只读 Component 与字段上下文。
 */
export function validateCodexComponentFields(context: PlatformComponentValidationContext): void {
  for (const field of Object.keys(context.fields)) {
    if (!COMPONENT_FIELDS.has(field)) {
      context.reportDiagnostic({
        code: 'CODEX_COMPONENT_FIELD_UNKNOWN',
        severity: 'error',
        message: `Unknown Codex ${context.component.kind} field "${field}".`,
        fieldPath: ['platforms', 'codex', field],
      });
    }
  }

  /** fields 提供按字段名执行官方 Schema 校验的只读视图。 */
  const fields: UnknownFields = context.fields;
  for (const field of ['displayName', 'shortDescription', 'defaultPrompt']) {
    if (fields[field] !== undefined && !isNonEmptyString(fields[field]))
      reportFieldError(context, field, `${field} must be a non-empty string.`);
  }
  for (const field of ['iconSmall', 'iconLarge']) {
    if (fields[field] !== undefined
      && (!isNonEmptyString(fields[field]) || !isSafeSkillPath(fields[field]))) {
      reportFieldError(context, field, `${field} must start with ./ and stay inside the generated Skill root.`);
    }
  }
  if (fields.brandColor !== undefined
    && (!isNonEmptyString(fields.brandColor) || !CODEX_BRAND_COLOR_PATTERN.test(fields.brandColor))) {
    reportFieldError(context, 'brandColor', 'brandColor must be a six-digit hexadecimal color.');
  }
  if (fields.products !== undefined
    && (!isUniqueStringArray(fields.products) || fields.products.some(product => !PRODUCTS.has(product)))) {
    reportFieldError(context, 'products', 'products must contain CHAT, CODEX, or both without duplicates.');
  }
}

/**
 * 读取一个 Component 中已由 Scanner 校验的 Codex 专属字段。
 *
 * @param component 当前准备转换的规范 Component。
 * @returns 缺省为空对象的平台字段视图。
 */
function codexFields(component: Component): UnknownFields {
  return component.platforms.codex ?? {};
}

/**
 * 列出全部规范 Component 最终占用的 Codex Skill ID。
 *
 * @param project 已完成规范扫描的 Plugin 工程。
 * @returns 保持 Component 类型与扫描顺序的生成身份。
 */
function generatedSkillIdentities(project: PluginProject): GeneratedSkillIdentity[] {
  return [
    ...project.skills.map(skill => ({ id: skill.id, subject: `skill:${skill.id}` })),
    ...project.commands.map(command => ({ id: `command-${command.id}`, subject: `command:${command.id}` })),
    ...project.agents.map(agent => ({ id: `agent-${agent.id}`, subject: `agent:${agent.id}` })),
  ];
}

/**
 * 在 prepare 阶段拒绝规范 ID 与 fallback ID 的大小写不敏感冲突。
 *
 * @param context Codex Platform prepare 上下文。
 */
export function validateGeneratedSkillIds(context: PlatformPrepareContext): void {
  /** 已经占用最终 ID 的首个规范 Component。 */
  const owners = new Map<string, GeneratedSkillIdentity>();
  for (const identity of generatedSkillIdentities(context.project)) {
    /** Codex 安装表面应采用大小写不敏感的稳定冲突规则。 */
    const key = identity.id.toLocaleLowerCase('en-US');
    /** 已经占用同一最终 ID 的来源。 */
    const owner = owners.get(key);
    if (owner !== undefined) {
      context.reportDiagnostic({
        code: 'CODEX_GENERATED_SKILL_ID_COLLISION',
        severity: 'error',
        message: `${owner.subject} and ${identity.subject} both generate Codex Skill ID "${identity.id}".`,
        hint: 'Rename one canonical Component so every native and fallback Skill ID is unique.',
      });
    } else {
      owners.set(key, identity);
    }
  }
}

/**
 * 创建符合当前官方 Schema 的 Skill 展示与调用策略元数据。
 *
 * `agents/openai.yaml` 一旦存在就必须同时提供 `interface.display_name` 和
 * `interface.short_description`，因此策略文件不能只写 `policy`。
 *
 * @param component 提供默认名称、说明和 Codex 专属字段的规范 Component。
 * @param generatedId 最终生成的 Codex Skill ID。
 * @param allowImplicitInvocation 是否允许模型根据描述隐式触发。
 * @returns 无需元数据时返回 undefined，否则返回完整官方结构。
 */
function skillMetadata(
  component: Component,
  generatedId: string,
  allowImplicitInvocation: boolean,
): OpenAiSkillMetadata | undefined {
  /** 当前 Component 已通过 Scanner 校验的平台字段。 */
  const fields = codexFields(component);
  /** 作者是否显式声明了任一 Codex Skill 展示或策略字段。 */
  const hasFields = Object.keys(fields).length > 0;
  if (allowImplicitInvocation && !hasFields)
    return undefined;
  /** 只有显式 products 或禁用隐式调用时才需要 policy 区域。 */
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

/**
 * 把可选 Skill 元数据添加到当前 Artifact 列表。
 *
 * @param artifacts 当前 Platform 生成中的 Artifact 集合。
 * @param component 元数据来源 Component。
 * @param generatedId 最终 Skill ID。
 * @param allowImplicitInvocation 是否允许隐式调用。
 */
function appendSkillMetadata(
  artifacts: ArtifactInput[],
  component: Component,
  generatedId: string,
  allowImplicitInvocation: boolean,
): void {
  /** 按官方必填 interface 规则创建的可选元数据。 */
  const metadata = skillMetadata(component, generatedId, allowImplicitInvocation);
  if (metadata !== undefined) {
    artifacts.push(bytesArtifact(
      `skills/${generatedId}/agents/openai.yaml`,
      `${stableYaml(metadata)}\n`,
    ));
  }
}

/**
 * 把规范 Commands、Skills 与 Agents 转换为 Codex Skills。
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
    appendSkillMetadata(artifacts, skill, skill.id, skill.invocation.model);
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
      reason: 'Codex supports plugin Skills natively.',
    });
    if (!skill.invocation.user) {
      context.reportCompatibility({
        subject: `skill:${skill.id}`,
        capability: 'invocation.user',
        level: 'degraded',
        transformation: 'The Skill remains explicitly invocable.',
        reason: 'Codex Skill metadata cannot disable explicit user invocation.',
      });
    }
  }

  for (const command of context.project.commands) {
    /** Command 使用固定前缀进入统一 Codex Skill 命名空间。 */
    const id = `command-${command.id}`;
    artifacts.push(bytesArtifact(`skills/${id}/SKILL.md`, markdownWithFrontmatter({
      name: id,
      description: command.description,
    }, command.body.replaceAll('{{arguments}}', 'the arguments supplied with this explicit invocation'))));
    appendSkillMetadata(artifacts, command, id, false);
    context.reportCompatibility({
      subject: `command:${command.id}`,
      capability: 'component',
      level: 'transform',
      transformation: `Explicit Skill ${id}`,
      reason: 'Codex represents Commands as explicitly invoked Skills.',
    });
    if (command.body.includes('{{arguments}}')) {
      context.reportCompatibility({
        subject: `command:${command.id}`,
        capability: 'arguments',
        level: 'transform',
        transformation: 'The arguments placeholder becomes explicit invocation guidance.',
        reason: 'Codex Skills receive arguments through the invoking prompt rather than a Command placeholder.',
      });
    }
    if (command.argumentHint !== undefined) {
      context.reportCompatibility({
        subject: `command:${command.id}`,
        capability: 'argumentHint',
        level: 'degraded',
        transformation: `Explicit Skill ${id} without argument hint UI`,
        reason: 'Codex Skills do not expose the Command argument hint field.',
      });
    }
  }

  for (const agent of context.project.agents) {
    /** Agent 使用固定前缀进入统一 Codex Skill 命名空间。 */
    const id = `agent-${agent.id}`;
    /** 降级正文明确区分作者意图与平台无法强制的运行约束。 */
    const guidance = [
      agent.body,
      '',
      `Intended model class: ${agent.model}.`,
      `Intended capabilities: ${agent.capabilities.join(', ') || 'none declared'}.`,
      'When delegation is available, use a focused subagent with this role. These settings are guidance, not enforced registration.',
    ].join('\n');
    artifacts.push(bytesArtifact(`skills/${id}/SKILL.md`, markdownWithFrontmatter({
      name: id,
      description: agent.description,
    }, guidance)));
    appendSkillMetadata(artifacts, agent, id, true);
    context.reportCompatibility({
      subject: `agent:${agent.id}`,
      capability: 'component',
      level: 'degraded',
      transformation: `Guidance-only Skill ${id}`,
      reason: 'Codex installable plugins cannot register project or user custom Agents.',
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
        reason: 'A fallback Skill cannot enforce an Agent tool capability boundary.',
      });
    }
  }
  return artifacts;
}

/**
 * 判断工程是否至少生成一个 Codex Skill。
 *
 * @param project 已完成扫描和依赖图校验的规范工程。
 * @returns 原生或 fallback Skill 目录非空时返回 true。
 */
export function hasGeneratedSkills(project: PluginProject): boolean {
  return project.skills.length + project.commands.length + project.agents.length > 0;
}
