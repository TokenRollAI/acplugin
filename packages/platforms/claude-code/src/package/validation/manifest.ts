/** Claude Code Plugin Manifest 与安装根引用 validator。 */
import type { JsonValue } from '@tokenroll/acplugin/sdk';
import { validateHookConfig, validateHookFile } from './hooks.js';
import { validateMcpFile, validateMcpServers } from './mcp.js';
import {
  isRecord,
  isSafePluginReference,
  referenceExists,
  report,
  scopedAssets,
  type JsonRecord,
  type PlatformValidateContext,
} from './shared.js';

/** Claude Code Plugin 清单允许出现的官方根字段。 */
const PLUGIN_FIELDS = new Set([
  '$schema', 'name', 'version', 'description', 'displayName', 'author', 'homepage', 'repository', 'license',
  'keywords', 'metadata', 'defaultEnabled', 'commands', 'agents', 'skills', 'hooks', 'mcpServers', 'lspServers',
  'outputStyles', 'experimental', 'dependencies',
]);

/** 由当前 Platform 生成并需要执行安装根引用验证的 Component 字段。 */
const COMPONENT_REFERENCE_FIELDS = ['commands', 'skills', 'agents'] as const;

/** 允许按路径或内联对象表达的 Extension 字段。 */
const EXTENSION_REFERENCE_FIELDS = ['hooks', 'mcpServers'] as const;

/** Claude Code Plugin 名称允许使用的小写 kebab-case 规则。 */
const PLUGIN_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * 校验一个清单引用值的类型、安全性和安装根内存在性。
 *
 * @param context Platform validatePackage 生命周期上下文。
 * @param assets 当前 Package 的 Asset 路径集合。
 * @param field 当前引用所属的清单字段。
 * @param value 单路径或路径数组候选。
 */
function validateReferences(
  context: PlatformValidateContext,
  assets: ReadonlySet<string>,
  field: string,
  value: JsonValue,
): void {
  /** 统一转换后的引用列表，保持清单声明顺序。 */
  const references = typeof value === 'string'
    ? [value]
    : Array.isArray(value) && value.every(item => typeof item === 'string')
      ? value as readonly string[]
      : undefined;
  if (references === undefined || references.length === 0) {
    report(context, 'CLAUDE_MANIFEST_REFERENCE_INVALID', `${field} must be a path or non-empty path array.`, [field]);
    return;
  }
  for (const [index, reference] of references.entries()) {
    /** 当前引用在单值或数组字段中的诊断位置。 */
    const fieldPath: readonly (string | number)[] = references.length === 1 ? [field] : [field, index];
    if (!isSafePluginReference(reference)) {
      report(context, 'CLAUDE_MANIFEST_REFERENCE_UNSAFE', `${field} references must start with ./ and stay inside the Plugin root.`, fieldPath);
    } else if (!referenceExists(assets, reference)) {
      report(context, 'CLAUDE_MANIFEST_REFERENCE_MISSING', `${field} references a missing Plugin file or directory.`, fieldPath);
    }
  }
}

/**
 * 校验 Claude Code Plugin 清单字段、Component 目录和 Extension 引用。
 *
 * @param context Platform validatePackage 生命周期上下文。
 * @param manifest 已解析的 Plugin 清单对象。
 * @param pluginRoot Plugin 相对于候选 Distribution 根的安装目录。
 */
export async function validatePluginManifest(
  context: PlatformValidateContext,
  manifest: JsonRecord,
  pluginRoot = '',
): Promise<void> {
  /** 当前 Plugin 安装根内的相对 Asset 路径集合。 */
  const assets = scopedAssets(context, pluginRoot);
  for (const field of Object.keys(manifest)) {
    if (!PLUGIN_FIELDS.has(field))
      report(context, 'CLAUDE_MANIFEST_FIELD_UNKNOWN', `Unknown Claude Code Plugin field "${field}".`, [field]);
  }
  /** 必填字符串字段及其期望的非空值。 */
  const required = ['name', 'version', 'description'] as const;
  for (const field of required) {
    if (typeof manifest[field] !== 'string' || manifest[field].trim().length === 0)
      report(context, 'CLAUDE_MANIFEST_FIELD_REQUIRED', `${field} must be a non-empty string.`, [field]);
  }
  if (typeof manifest.name === 'string' && !PLUGIN_NAME_PATTERN.test(manifest.name))
    report(context, 'CLAUDE_MANIFEST_NAME_INVALID', 'name must use lowercase kebab-case.', ['name']);
  /** 可选字符串元数据必须保持非空字符串形态。 */
  const optionalStrings = ['displayName', 'homepage', 'repository', 'license'] as const;
  for (const field of optionalStrings) {
    if (manifest[field] !== undefined && (typeof manifest[field] !== 'string' || manifest[field].trim().length === 0))
      report(context, 'CLAUDE_MANIFEST_METADATA_INVALID', `${field} must be a non-empty string.`, [field]);
  }
  if (manifest.author !== undefined) {
    /** Plugin 清单中经过对象形态检查的作者字段。 */
    const author = isRecord(manifest.author) ? manifest.author : undefined;
    if (author === undefined || typeof author.name !== 'string' || author.name.trim().length === 0) {
      report(context, 'CLAUDE_MANIFEST_AUTHOR_INVALID', 'author.name must be a non-empty string.', ['author', 'name']);
    } else {
      /** author 的可选联系字段只能是非空字符串。 */
      const authorFields = ['email', 'url'] as const;
      for (const field of authorFields) {
        if (author[field] !== undefined && (typeof author[field] !== 'string' || author[field].trim().length === 0))
          report(context, 'CLAUDE_MANIFEST_AUTHOR_INVALID', `author.${field} must be a non-empty string.`, ['author', field]);
      }
    }
  }
  if (manifest.keywords !== undefined
    && (!Array.isArray(manifest.keywords)
      || manifest.keywords.some(keyword => typeof keyword !== 'string' || keyword.trim().length === 0)
      || new Set(manifest.keywords).size !== manifest.keywords.length)) {
    report(context, 'CLAUDE_MANIFEST_KEYWORDS_INVALID', 'keywords must contain unique non-empty strings.', ['keywords']);
  }
  if (manifest.defaultEnabled !== undefined && typeof manifest.defaultEnabled !== 'boolean')
    report(context, 'CLAUDE_MANIFEST_DEFAULT_INVALID', 'defaultEnabled must be a boolean.', ['defaultEnabled']);
  for (const field of COMPONENT_REFERENCE_FIELDS) {
    if (manifest[field] !== undefined)
      validateReferences(context, assets, field, manifest[field]);
  }
  for (const field of EXTENSION_REFERENCE_FIELDS) {
    /** 当前 Extension 添加的清单字段值。 */
    const value = manifest[field];
    if (value === undefined)
      continue;
    if (typeof value === 'string') {
      validateReferences(context, assets, field, value);
      if (field === 'hooks' && isSafePluginReference(value) && referenceExists(assets, value))
        await validateHookFile(context, pluginRoot, value, [field]);
      if (field === 'mcpServers' && isSafePluginReference(value) && referenceExists(assets, value))
        await validateMcpFile(context, pluginRoot, value, [field]);
    } else if (!isRecord(value)) {
      report(context, 'CLAUDE_EXTENSION_FIELD_INVALID', `${field} must be a Plugin path or inline object.`, [field]);
    } else if (field === 'hooks') {
      validateHookConfig(context, value, [field], false);
    } else {
      validateMcpServers(context, value, [field]);
    }
  }
  if (manifest.hooks === undefined && assets.has('hooks/hooks.json'))
    await validateHookFile(context, pluginRoot, './hooks/hooks.json', ['hooks']);
  /** Claude Code 会自动发现 Plugin 根 `.mcp.json`，即使 Manifest 未显式引用。 */
  if (manifest.mcpServers === undefined && assets.has('.mcp.json'))
    await validateMcpFile(context, pluginRoot, './.mcp.json', ['mcpServers']);
}
