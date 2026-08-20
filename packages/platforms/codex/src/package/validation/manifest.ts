/** Codex Plugin Manifest validator。 */
import { isCodexHttpsUrl } from '../protocol.js';
import { validateInterface } from './assets.js';
import { validateHookFile, validateHooks } from './hooks.js';
import { validateMcpFile } from './mcp.js';
import { validateSkills } from './skills.js';
import {
  isRecord,
  isSafePluginReference,
  referenceExists,
  report,
  scopedAssets,
  validateReference,
  type JsonRecord,
  type PlatformValidateContext,
} from './shared.js';

/** Codex Plugin Manifest 允许出现的当前官方根字段。 */
const PLUGIN_FIELDS = new Set([
  'id', 'name', 'version', 'description', 'author', 'homepage', 'repository', 'license', 'keywords',
  'skills', 'mcpServers', 'apps', 'hooks', 'interface',
]);

/** Codex Plugin 名称允许使用的官方 ASCII 规则。 */
const PLUGIN_NAME_PATTERN = /^[\dA-Za-z][\dA-Za-z_-]*$/;

/** 保守验证完整 Semantic Version 的规则。 */
const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[\dA-Za-z-]+(?:\.[\dA-Za-z-]+)*)?(?:\+[\dA-Za-z-]+(?:\.[\dA-Za-z-]+)*)?$/;

/**
 * 校验 Plugin Manifest 字段、Skill 根和 Extension 引用。
 *
 * @param context Platform validatePackage 生命周期上下文。
 * @param manifest 已解析的 Codex Plugin Manifest。
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
      report(context, 'CODEX_MANIFEST_FIELD_UNKNOWN', `Unknown Codex Plugin field "${field}".`, [field]);
  }
  /** Codex Plugin Manifest 的三个稳定必填字符串字段。 */
  const required = ['name', 'version', 'description'] as const;
  for (const field of required) {
    if (typeof manifest[field] !== 'string' || manifest[field].trim().length === 0)
      report(context, 'CODEX_MANIFEST_FIELD_REQUIRED', `${field} must be a non-empty string.`, [field]);
  }
  if (typeof manifest.name === 'string'
    && (manifest.name.length > 64 || !PLUGIN_NAME_PATTERN.test(manifest.name))) {
    report(context, 'CODEX_MANIFEST_NAME_INVALID', 'name must use the official ASCII Plugin name format and contain at most 64 characters.', ['name']);
  }
  if (typeof manifest.version === 'string'
    && (manifest.version.length > 64 || !SEMVER_PATTERN.test(manifest.version))) {
    report(context, 'CODEX_MANIFEST_VERSION_INVALID', 'version must be a semantic version.', ['version']);
  }
  if (typeof manifest.description === 'string' && manifest.description.length > 1_024)
    report(context, 'CODEX_MANIFEST_DESCRIPTION_INVALID', 'description must contain at most 1024 characters.', ['description']);
  if (manifest.author !== undefined) {
    /** 通过对象检查后的作者字段。 */
    const author = isRecord(manifest.author) ? manifest.author : undefined;
    if (author === undefined || typeof author.name !== 'string' || author.name.trim().length === 0) {
      report(context, 'CODEX_MANIFEST_AUTHOR_INVALID', 'author.name must be a non-empty string.', ['author', 'name']);
    } else {
      for (const field of ['email', 'url'] as const) {
        if (author[field] !== undefined && (typeof author[field] !== 'string' || author[field].trim().length === 0))
          report(context, 'CODEX_MANIFEST_AUTHOR_INVALID', `author.${field} must be a non-empty string.`, ['author', field]);
      }
      if (typeof author.url === 'string' && (!isCodexHttpsUrl(author.url) || author.url.length > 2_048))
        report(context, 'CODEX_MANIFEST_AUTHOR_URL_INVALID', 'author.url must be an HTTPS URL without credentials.', ['author', 'url']);
    }
  }
  for (const field of ['homepage', 'repository', 'license'] as const) {
    if (manifest[field] !== undefined && (typeof manifest[field] !== 'string' || manifest[field].trim().length === 0))
      report(context, 'CODEX_MANIFEST_METADATA_INVALID', `${field} must be a non-empty string.`, [field]);
  }
  if (typeof manifest.homepage === 'string' && (!isCodexHttpsUrl(manifest.homepage) || manifest.homepage.length > 2_048))
    report(context, 'CODEX_MANIFEST_HOMEPAGE_INVALID', 'homepage must be an HTTPS URL without credentials.', ['homepage']);
  if (manifest.keywords !== undefined
    && (!Array.isArray(manifest.keywords)
      || manifest.keywords.some(keyword => typeof keyword !== 'string' || keyword.trim().length === 0)
      || new Set(manifest.keywords).size !== manifest.keywords.length)) {
    report(context, 'CODEX_MANIFEST_KEYWORDS_INVALID', 'keywords must contain unique non-empty strings.', ['keywords']);
  }
  if (manifest.skills !== './skills/')
    report(context, 'CODEX_SKILLS_PATH_INVALID', 'skills must point to the root ./skills/ directory.', ['skills']);
  await validateSkills(context, assets, pluginRoot, typeof manifest.name === 'string' ? manifest.name : undefined);
  if (manifest.interface !== undefined)
    await validateInterface(context, assets, pluginRoot, manifest.interface);
  if (manifest.mcpServers !== undefined) {
    if (typeof manifest.mcpServers !== 'string') {
      report(context, 'CODEX_MCP_REFERENCE_INVALID', 'mcpServers must be a Plugin-root file path.', ['mcpServers']);
    } else {
      validateReference(context, assets, 'mcpServers', manifest.mcpServers, ['mcpServers']);
      if (isSafePluginReference(manifest.mcpServers) && referenceExists(assets, manifest.mcpServers))
        await validateMcpFile(context, pluginRoot, manifest.mcpServers, ['mcpServers']);
    }
  }
  if (manifest.hooks !== undefined)
    await validateHooks(context, assets, pluginRoot, manifest.hooks);
  else if (assets.has('hooks/hooks.json'))
    await validateHookFile(context, pluginRoot, './hooks/hooks.json', ['hooks']);
}
