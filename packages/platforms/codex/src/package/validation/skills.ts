/** Codex Skill Markdown 与 agents/openai.yaml validator。 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { CODEX_BRAND_COLOR_PATTERN, CODEX_SKILL_PRODUCTS } from '../protocol.js';
import {
  isRecord,
  isSafePluginReference,
  parseYamlObject,
  report,
  type PlatformValidateContext,
} from './shared.js';

/** Codex Skill `agents/openai.yaml` 允许出现的根字段。 */
const SKILL_METADATA_FIELDS = new Set(['interface', 'policy', 'dependencies']);

/** Codex Skill 元数据 `interface` 允许出现的 snake_case 字段。 */
const SKILL_INTERFACE_FIELDS = new Set([
  'display_name', 'short_description', 'icon_small', 'icon_large', 'brand_color', 'default_prompt',
]);

/**
 * 按 UTF-16 code unit 比较 Codex Skill ID，不依赖宿主 locale/ICU。
 *
 * @param left 左侧 ID。
 * @param right 右侧 ID。
 * @returns 与 Array.sort 约定一致的 -1、0 或 1。
 */
function compareCodeUnits(left: string, right: string): number {
  if (left === right)
    return 0;
  return left < right ? -1 : 1;
}

/** Codex Skill 元数据 `policy` 允许出现的字段。 */
const SKILL_POLICY_FIELDS = new Set(['products', 'allow_implicit_invocation']);

/** Codex Skill 元数据支持的产品范围。 */
const SKILL_PRODUCTS = new Set<string>(CODEX_SKILL_PRODUCTS);

/** Canonical 与 fallback Skill 最终目录使用的小写 kebab-case 规则。 */
const SKILL_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * 校验 Skill 元数据中的相对资源引用。
 *
 * @param context Platform validatePackage 生命周期上下文。
 * @param assets 当前 Package 的 Asset 路径集合。
 * @param pluginRoot Plugin 相对于候选 Distribution 根的安装目录。
 * @param skillId 当前 Skill 的最终目录 ID。
 * @param field 元数据资源字段名。
 * @param reference 相对于 Skill 根的资源路径。
 */
function validateSkillAssetReference(
  context: PlatformValidateContext,
  assets: ReadonlySet<string>,
  skillId: string,
  field: string,
  reference: string,
): void {
  /** Skill 资源遵循同一 `./` 安全规则，但解析基准是当前 Skill 根。 */
  if (!isSafePluginReference(reference)) {
    report(context, 'CODEX_SKILL_ASSET_UNSAFE', `${field} must start with ./ and stay inside the Skill root.`, ['skills', skillId, 'agents', 'openai.yaml', 'interface', field]);
    return;
  }
  /** Skill 相对引用转换后的完整 Asset 路径。 */
  const assetPath = `skills/${skillId}/${reference.slice(2)}`;
  if (!assets.has(assetPath)) {
    report(context, 'CODEX_SKILL_ASSET_MISSING', `${field} references a missing Skill asset.`, ['skills', skillId, 'agents', 'openai.yaml', 'interface', field]);
  }
}

/**
 * 校验一个 Skill 的 `agents/openai.yaml` 官方结构。
 *
 * @param context Platform validatePackage 生命周期上下文。
 * @param assets 当前 Package 的 Asset 路径集合。
 * @param skillId 当前 Skill 的最终目录 ID。
 */
async function validateSkillMetadata(
  context: PlatformValidateContext,
  assets: ReadonlySet<string>,
  pluginRoot: string,
  skillId: string,
): Promise<void> {
  /** 当前 Skill 元数据的固定 Asset 路径。 */
  const metadataPath = `skills/${skillId}/agents/openai.yaml`;
  if (!assets.has(metadataPath))
    return;
  try {
    /** 从已物化候选读取 UTF-8 Skill 元数据。 */
    const source = await fs.readFile(path.join(context.candidate.root, pluginRoot, metadataPath), 'utf8');
    /** YAML 顶层必须为可验证的映射。 */
    const metadata = parseYamlObject(context, source, metadataPath);
    if (metadata === undefined)
      return;
    for (const field of Object.keys(metadata)) {
      if (!SKILL_METADATA_FIELDS.has(field))
        report(context, 'CODEX_SKILL_METADATA_FIELD_UNKNOWN', `Unknown ${metadataPath} field "${field}".`);
    }
    if (!isRecord(metadata.interface)) {
      report(context, 'CODEX_SKILL_INTERFACE_REQUIRED', `${metadataPath} must contain an interface mapping.`);
      return;
    }
    /** Skill interface 中已经通过对象校验的字段。 */
    const skillInterface = metadata.interface;
    for (const field of Object.keys(skillInterface)) {
      if (!SKILL_INTERFACE_FIELDS.has(field))
        report(context, 'CODEX_SKILL_INTERFACE_FIELD_UNKNOWN', `Unknown Skill interface field "${field}".`);
    }
    /** Skill 元数据存在时必须同时提供的两个展示字段。 */
    for (const field of ['display_name', 'short_description'] as const) {
      if (typeof skillInterface[field] !== 'string' || skillInterface[field].trim().length === 0)
        report(context, 'CODEX_SKILL_INTERFACE_FIELD_REQUIRED', `Skill interface.${field} must be a non-empty string.`);
    }
    for (const field of ['icon_small', 'icon_large'] as const) {
      /** 当前可选 Skill 图片引用。 */
      const candidate = skillInterface[field];
      if (candidate !== undefined) {
        if (typeof candidate !== 'string' || candidate.trim().length === 0)
          report(context, 'CODEX_SKILL_ASSET_INVALID', `Skill interface.${field} must be a non-empty path.`);
        else
          validateSkillAssetReference(context, assets, skillId, field, candidate);
      }
    }
    if (skillInterface.brand_color !== undefined
      && (typeof skillInterface.brand_color !== 'string' || !CODEX_BRAND_COLOR_PATTERN.test(skillInterface.brand_color))) {
      report(context, 'CODEX_SKILL_BRAND_COLOR_INVALID', 'Skill interface.brand_color must be a six-digit hexadecimal color.');
    }
    if (skillInterface.default_prompt !== undefined
      && (typeof skillInterface.default_prompt !== 'string' || skillInterface.default_prompt.trim().length === 0)) {
      report(context, 'CODEX_SKILL_DEFAULT_PROMPT_INVALID', 'Skill interface.default_prompt must be a non-empty string.');
    }
    if (metadata.policy !== undefined) {
      if (!isRecord(metadata.policy)) {
        report(context, 'CODEX_SKILL_POLICY_INVALID', 'Skill policy must be a YAML mapping.');
      } else {
        for (const field of Object.keys(metadata.policy)) {
          if (!SKILL_POLICY_FIELDS.has(field))
            report(context, 'CODEX_SKILL_POLICY_FIELD_UNKNOWN', `Unknown Skill policy field "${field}".`);
        }
        if (metadata.policy.allow_implicit_invocation !== undefined
          && typeof metadata.policy.allow_implicit_invocation !== 'boolean') {
          report(context, 'CODEX_SKILL_POLICY_INVALID', 'Skill policy.allow_implicit_invocation must be a boolean.');
        }
        if (metadata.policy.products !== undefined
          && (!Array.isArray(metadata.policy.products)
            || metadata.policy.products.length === 0
            || metadata.policy.products.some(product => typeof product !== 'string' || !SKILL_PRODUCTS.has(product))
            || new Set(metadata.policy.products).size !== metadata.policy.products.length)) {
          report(context, 'CODEX_SKILL_POLICY_INVALID', 'Skill policy.products must contain CHAT, CODEX, or both without duplicates.');
        }
      }
    }
    if (metadata.dependencies !== undefined) {
      if (!isRecord(metadata.dependencies)
        || Object.keys(metadata.dependencies).some(field => field !== 'tools')
        || !Array.isArray(metadata.dependencies.tools)) {
        report(context, 'CODEX_SKILL_DEPENDENCIES_INVALID', 'Skill dependencies may contain only a tools array.');
      }
    }
  } catch {
    report(context, 'CODEX_SKILL_METADATA_READ_FAILED', `${metadataPath} must be readable UTF-8 YAML.`);
  }
}

/**
 * 校验一个最终 Skill 的 Markdown、frontmatter、正文与可选元数据。
 *
 * @param context Platform validatePackage 生命周期上下文。
 * @param assets 当前 Package 的 Asset 路径集合。
 * @param pluginRoot Plugin 相对于候选 Distribution 根的安装目录。
 * @param pluginName 当前 Plugin 的稳定机器名称。
 * @param skillId 当前 Skill 的最终目录 ID。
 * @param names 已验证 Skill frontmatter 名称的全局索引。
 */
async function validateSkill(
  context: PlatformValidateContext,
  assets: ReadonlySet<string>,
  pluginRoot: string,
  pluginName: string | undefined,
  skillId: string,
  names: Set<string>,
): Promise<void> {
  /** 当前 Skill Manifest 的固定 Asset 路径。 */
  const manifestPath = `skills/${skillId}/SKILL.md`;
  if (!assets.has(manifestPath)) {
    report(context, 'CODEX_SKILL_MANIFEST_MISSING', `Skill directory "${skillId}" must contain SKILL.md.`, ['skills', skillId]);
    return;
  }
  try {
    /** 从已物化候选读取最终 Skill Markdown。 */
    const source = await fs.readFile(path.join(context.candidate.root, pluginRoot, manifestPath), 'utf8');
    /** Frontmatter 与正文使用固定边界，拒绝缺失或未闭合标记。 */
    const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/u.exec(source);
    if (match === null) {
      report(context, 'CODEX_SKILL_FRONTMATTER_INVALID', `${manifestPath} must start with closed YAML frontmatter.`);
      return;
    }
    /** 已从正则边界提取的 YAML frontmatter。 */
    const frontmatter = parseYamlObject(context, match[1]!, manifestPath);
    if (frontmatter === undefined)
      return;
    /** frontmatter 声明的 Skill 机器名称。 */
    const name = frontmatter.name;
    if (typeof name !== 'string' || !SKILL_ID_PATTERN.test(name)) {
      report(context, 'CODEX_SKILL_NAME_INVALID', `${manifestPath} name must use lowercase kebab-case.`);
    } else {
      /** Skill name 按平台最终选择器语义执行大小写不敏感唯一性。 */
      const key = name.toLocaleLowerCase('en-US');
      if (names.has(key))
        report(context, 'CODEX_SKILL_NAME_DUPLICATE', `Skill name "${name}" is duplicated.`);
      names.add(key);
      if (name !== skillId)
        report(context, 'CODEX_SKILL_NAME_MISMATCH', `${manifestPath} name must match its directory ID "${skillId}".`);
      if (pluginName !== undefined && `${pluginName}:${name}`.length > 64)
        report(context, 'CODEX_SKILL_IDENTITY_TOO_LONG', `Plugin and Skill identity "${pluginName}:${name}" exceeds 64 characters.`);
    }
    if (typeof frontmatter.description !== 'string'
      || frontmatter.description.trim().length === 0
      || frontmatter.description.length > 1_024) {
      report(context, 'CODEX_SKILL_DESCRIPTION_INVALID', `${manifestPath} description must contain 1 to 1024 characters.`);
    }
    if (match[2]!.trim().length === 0)
      report(context, 'CODEX_SKILL_BODY_EMPTY', `${manifestPath} instructions must not be empty.`);
    await validateSkillMetadata(context, assets, pluginRoot, skillId);
  } catch {
    report(context, 'CODEX_SKILL_READ_FAILED', `${manifestPath} must be readable UTF-8 Markdown.`);
  }
}

/**
 * 校验 `skills/` 根下每个直接子目录及其内容协议。
 *
 * @param context Platform validatePackage 生命周期上下文。
 * @param assets 当前 Package 的 Asset 路径集合。
 * @param pluginRoot Plugin 相对于候选 Distribution 根的安装目录。
 * @param pluginName 当前 Plugin 的稳定机器名称。
 */
export async function validateSkills(
  context: PlatformValidateContext,
  assets: ReadonlySet<string>,
  pluginRoot: string,
  pluginName: string | undefined,
): Promise<void> {
  /** 从任意 Skill Asset 收集的直接子目录 ID。 */
  const directories = new Set<string>();
  for (const asset of assets) {
    if (!asset.startsWith('skills/'))
      continue;
    /** 当前 Skill Asset 的 POSIX 路径片段。 */
    const segments = asset.split('/');
    if (segments.length < 3 || segments[1] === '') {
      report(context, 'CODEX_SKILL_PATH_INVALID', `Invalid Skill Asset path "${asset}".`, ['skills']);
      continue;
    }
    directories.add(segments[1]!);
    if (asset.endsWith('/SKILL.md') && segments.length !== 3)
      report(context, 'CODEX_SKILL_MANIFEST_NESTED', 'SKILL.md must be an immediate child of its Skill directory.', ['skills', segments[1]!]);
  }
  if (directories.size === 0) {
    report(context, 'CODEX_SKILL_REQUIRED', 'A Codex Plugin must contain at least one immediate child Skill.', ['skills']);
    return;
  }
  /** 已验证 Skill frontmatter 名称的全局唯一性集合。 */
  const names = new Set<string>();
  /** skillId 表示当前排序后的 Skill，用于生成确定诊断顺序。 */
  for (const skillId of [...directories].sort(compareCodeUnits)) {
    if (!SKILL_ID_PATTERN.test(skillId))
      report(context, 'CODEX_SKILL_DIRECTORY_INVALID', `Skill directory "${skillId}" must use lowercase kebab-case.`, ['skills', skillId]);
    await validateSkill(context, assets, pluginRoot, pluginName, skillId, names);
  }
}
