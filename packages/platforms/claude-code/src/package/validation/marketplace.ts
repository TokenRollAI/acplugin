/** Claude Code Marketplace Distribution validator。 */
import { PLUGIN_MANIFEST_PATH } from '../manifest.js';
import { validatePluginManifest } from './manifest.js';
import {
  isRecord,
  readJson,
  report,
  type JsonRecord,
  type PlatformValidateContext,
} from './shared.js';

/** 多 Plugin Marketplace 的本地来源必须使用稳定单元目录。 */
const MARKETPLACE_PLUGIN_SOURCE_PATTERN = /^\.\/plugins\/[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Claude Code Marketplace 根清单允许出现的官方字段。 */
const MARKETPLACE_FIELDS = new Set(['name', 'owner', 'description', 'version', 'metadata', 'plugins']);

/** Claude Code Marketplace 每个 Plugin 条目允许出现的官方字段。 */
const MARKETPLACE_PLUGIN_FIELDS = new Set([
  'name', 'source', 'description', 'version', 'author', 'homepage', 'repository', 'license', 'keywords',
  'category', 'tags', 'strict',
]);

/**
 * 校验 Marketplace 根清单与自包含 Plugin 的身份和引用。
 *
 * @param context Platform validatePackage 生命周期上下文。
 * @param marketplace 已解析的 Marketplace 清单。
 */
export async function validateMarketplace(
  context: PlatformValidateContext,
  marketplace: JsonRecord,
): Promise<void> {
  for (const field of Object.keys(marketplace)) {
    if (!MARKETPLACE_FIELDS.has(field))
      report(context, 'CLAUDE_MARKETPLACE_FIELD_UNKNOWN', `Unknown Claude Code Marketplace field "${field}".`, [field]);
  }
  if (typeof marketplace.name !== 'string' || marketplace.name.trim().length === 0)
    report(context, 'CLAUDE_MARKETPLACE_NAME_REQUIRED', 'Marketplace name must be a non-empty string.', ['name']);
  if (!isRecord(marketplace.owner) || typeof marketplace.owner.name !== 'string' || marketplace.owner.name.trim().length === 0) {
    report(context, 'CLAUDE_MARKETPLACE_OWNER_REQUIRED', 'Marketplace owner.name must be present.', ['owner', 'name']);
  } else {
    /** Marketplace owner 可选联系方式字段。 */
    const ownerFields = ['email', 'url'] as const;
    for (const field of ownerFields) {
      if (marketplace.owner[field] !== undefined
        && (typeof marketplace.owner[field] !== 'string' || marketplace.owner[field].trim().length === 0)) {
        report(context, 'CLAUDE_MARKETPLACE_OWNER_INVALID', `Marketplace owner.${field} must be a non-empty string.`, ['owner', field]);
      }
    }
  }
  if (typeof marketplace.description !== 'string' || marketplace.description.trim().length === 0)
    report(context, 'CLAUDE_MARKETPLACE_DESCRIPTION_REQUIRED', 'Marketplace description must be a non-empty string.', ['description']);
  if (typeof marketplace.version !== 'string' || marketplace.version.trim().length === 0)
    report(context, 'CLAUDE_MARKETPLACE_VERSION_REQUIRED', 'Marketplace version must be a non-empty string.', ['version']);
  if (!isRecord(marketplace.metadata) || marketplace.metadata.pluginRoot !== './')
    report(context, 'CLAUDE_MARKETPLACE_ROOT_INVALID', 'Marketplace metadata.pluginRoot must be "./".', ['metadata', 'pluginRoot']);
  if (!Array.isArray(marketplace.plugins)
    || marketplace.plugins.length === 0
    || marketplace.plugins.some(entry => !isRecord(entry))) {
    report(context, 'CLAUDE_MARKETPLACE_PLUGIN_REQUIRED', 'Marketplace must contain one or more Plugin entries.', ['plugins']);
    return;
  }
  /** 已验证来源用于阻止两个条目指向同一 Plugin 根。 */
  const sources = new Set<string>();
  /** 已验证名称用于阻止 Marketplace 内出现选择器歧义。 */
  const names = new Set<string>();
  /** [index, entryValue] 表示当前 Marketplace Plugin 条目。 */
  for (const [index, entryValue] of marketplace.plugins.entries()) {
    /** plugins 已经整体通过对象检查后的当前条目。 */
    const entry = entryValue as JsonRecord;
    for (const field of Object.keys(entry)) {
      if (!MARKETPLACE_PLUGIN_FIELDS.has(field))
        report(context, 'CLAUDE_MARKETPLACE_PLUGIN_FIELD_UNKNOWN', `Unknown Marketplace Plugin field "${field}".`, ['plugins', index, field]);
    }
    /** 当前条目声明的本地 Plugin 来源。 */
    const source = entry.source;
    /** 单项保持兼容根布局，多项必须各自进入稳定 plugins 子目录。 */
    const sourceValid = typeof source === 'string'
      && (marketplace.plugins.length === 1 ? source === './' : MARKETPLACE_PLUGIN_SOURCE_PATTERN.test(source));
    if (!sourceValid) {
      report(context, 'CLAUDE_MARKETPLACE_SOURCE_INVALID', 'Single-Plugin source must be "./"; multi-Plugin sources must use "./plugins/<unit-id>".', ['plugins', index, 'source']);
      continue;
    }
    if (sources.has(source))
      report(context, 'CLAUDE_MARKETPLACE_SOURCE_DUPLICATE', 'Marketplace Plugin sources must be unique.', ['plugins', index, 'source']);
    sources.add(source);
    /** `./` 对应 Distribution 根，其余来源去掉协议前缀后作为 Plugin 根。 */
    const pluginRoot = source === './' ? '' : source.slice(2);
    /** 当前来源根内必须存在且可解析的 Claude Code Plugin Manifest。 */
    const plugin = await readJson(context, pluginRoot === '' ? PLUGIN_MANIFEST_PATH : `${pluginRoot}/${PLUGIN_MANIFEST_PATH}`);
    if (plugin === undefined)
      continue;
    await validatePluginManifest(context, plugin, pluginRoot);
    if (entry.name !== plugin.name || entry.version !== plugin.version || entry.description !== plugin.description) {
      report(context, 'CLAUDE_MARKETPLACE_PLUGIN_MISMATCH', 'Marketplace Plugin metadata must match its bundled Plugin manifest.', ['plugins', index]);
    }
    if (typeof entry.name === 'string') {
      /** Marketplace 名称使用平台选择器的大小写敏感规范值。 */
      const name = entry.name;
      if (names.has(name))
        report(context, 'CLAUDE_MARKETPLACE_PLUGIN_DUPLICATE', 'Marketplace Plugin names must be unique.', ['plugins', index, 'name']);
      names.add(name);
    }
    if (entry.strict !== true)
      report(context, 'CLAUDE_MARKETPLACE_STRICT_REQUIRED', 'Self-contained Marketplace Plugins must use strict: true.', ['plugins', index, 'strict']);
    // 当前单 Plugin 兼容布局继续要求 Marketplace 根元数据与唯一 Plugin 一致。
    if (marketplace.plugins.length === 1
      && (marketplace.description !== plugin.description || marketplace.version !== plugin.version)) {
      report(context, 'CLAUDE_MARKETPLACE_METADATA_MISMATCH', 'Single-Plugin Marketplace description and version must match the bundled Plugin.', []);
    }
  }
}
