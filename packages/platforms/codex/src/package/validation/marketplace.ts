/** Codex Marketplace Distribution validator。 */
import {
  CODEX_CATEGORIES,
  CODEX_MARKETPLACE_INSTALLATIONS,
} from '../protocol.js';
import { PLUGIN_MANIFEST_PATH } from '../manifest.js';
import { validatePluginManifest } from './manifest.js';
import {
  isRecord,
  readJson,
  report,
  type JsonRecord,
  type PlatformValidateContext,
} from './shared.js';

/** Codex Marketplace 根清单允许出现的字段。 */
const MARKETPLACE_FIELDS = new Set(['name', 'interface', 'plugins']);

/** Codex Marketplace 每个 Plugin 条目允许出现的字段。 */
const MARKETPLACE_PLUGIN_FIELDS = new Set(['name', 'source', 'policy', 'category']);

/** Codex Marketplace 当前支持的安装策略。 */
const INSTALLATION_POLICIES = new Set<string>(CODEX_MARKETPLACE_INSTALLATIONS);

/** Codex 官方插件目录当前接受的分类。 */
const CATEGORIES = new Set<string>(CODEX_CATEGORIES);

/** 多 Plugin Marketplace 的本地来源必须使用稳定单元目录。 */
const MARKETPLACE_PLUGIN_SOURCE_PATTERN = /^\.\/plugins\/[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * 校验 Marketplace 根清单和自包含 Plugin 来源。
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
      report(context, 'CODEX_MARKETPLACE_FIELD_UNKNOWN', `Unknown Codex Marketplace field "${field}".`, [field]);
  }
  if (typeof marketplace.name !== 'string' || marketplace.name.trim().length === 0)
    report(context, 'CODEX_MARKETPLACE_NAME_REQUIRED', 'Marketplace name must be a non-empty string.', ['name']);
  if (!isRecord(marketplace.interface)
    || typeof marketplace.interface.displayName !== 'string'
    || marketplace.interface.displayName.trim().length === 0) {
    report(context, 'CODEX_MARKETPLACE_INTERFACE_REQUIRED', 'Marketplace interface.displayName must be present.', ['interface', 'displayName']);
  }
  if (!Array.isArray(marketplace.plugins)
    || marketplace.plugins.length === 0
    || marketplace.plugins.some(entry => !isRecord(entry))) {
    report(context, 'CODEX_MARKETPLACE_PLUGIN_REQUIRED', 'Marketplace must contain one or more Plugin entries.', ['plugins']);
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
        report(context, 'CODEX_MARKETPLACE_PLUGIN_FIELD_UNKNOWN', `Unknown Marketplace Plugin field "${field}".`, ['plugins', index, field]);
    }
    /** 已通过对象形态检查的本地来源候选。 */
    const source = isRecord(entry.source) ? entry.source : undefined;
    /** 当前来源中的本地路径候选。 */
    const sourcePath = source?.path;
    /** 单项保持兼容根布局，多项必须各自进入稳定 plugins 子目录。 */
    const sourceValid = source?.source === 'local'
      && typeof sourcePath === 'string'
      && (marketplace.plugins.length === 1 ? sourcePath === './' : MARKETPLACE_PLUGIN_SOURCE_PATTERN.test(sourcePath));
    if (!sourceValid) {
      report(context, 'CODEX_MARKETPLACE_SOURCE_INVALID', 'Single-Plugin source must be local "./"; multi-Plugin sources must use "./plugins/<unit-id>".', ['plugins', index, 'source']);
      continue;
    }
    if (sources.has(sourcePath))
      report(context, 'CODEX_MARKETPLACE_SOURCE_DUPLICATE', 'Marketplace Plugin sources must be unique.', ['plugins', index, 'source', 'path']);
    sources.add(sourcePath);
    /** `./` 对应 Distribution 根，其余来源去掉协议前缀后作为 Plugin 根。 */
    const pluginRoot = sourcePath === './' ? '' : sourcePath.slice(2);
    /** 当前来源根内必须存在且可解析的 Codex Plugin Manifest。 */
    const plugin = await readJson(context, pluginRoot === '' ? PLUGIN_MANIFEST_PATH : `${pluginRoot}/${PLUGIN_MANIFEST_PATH}`);
    if (plugin === undefined)
      continue;
    await validatePluginManifest(context, plugin, pluginRoot);
    if (entry.name !== plugin.name)
      report(context, 'CODEX_MARKETPLACE_PLUGIN_MISMATCH', 'Marketplace Plugin name must match its bundled Plugin Manifest.', ['plugins', index, 'name']);
    if (typeof entry.name === 'string') {
      /** Marketplace 名称使用 Plugin Manifest 的稳定选择器值。 */
      const name = entry.name;
      if (names.has(name))
        report(context, 'CODEX_MARKETPLACE_PLUGIN_DUPLICATE', 'Marketplace Plugin names must be unique.', ['plugins', index, 'name']);
      names.add(name);
    }
    if (!isRecord(entry.policy)
      || typeof entry.policy.installation !== 'string'
      || !INSTALLATION_POLICIES.has(entry.policy.installation)
      || entry.policy.authentication !== 'ON_INSTALL') {
      report(context, 'CODEX_MARKETPLACE_POLICY_INVALID', 'Marketplace policy must include a supported installation value and ON_INSTALL authentication.', ['plugins', index, 'policy']);
    }
    if (typeof entry.category !== 'string' || !CATEGORIES.has(entry.category))
      report(context, 'CODEX_MARKETPLACE_CATEGORY_INVALID', 'Marketplace category must be an official Plugin category.', ['plugins', index, 'category']);
  }
}
