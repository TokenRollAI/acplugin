import {
  stableJson,
  type DistributionAssetInput,
  type DistributionContext,
  type JsonObject,
  type MetadataDispositionInput,
  type PackageDocumentInput,
  type PluginMetadata,
} from '@tokenroll/acplugin/sdk';
import type {
  ClaudeCodeMarketplaceManifest,
  ClaudeCodeMarketplaceOptions,
  ClaudeCodeMarketplacePlugin,
  ClaudeCodePlatformOptions,
  ClaudeCodePluginManifest,
} from '../types.js';

/** Claude Code Plugin 清单的稳定逻辑 Document ID。 */
export const PLUGIN_MANIFEST_ID = 'plugin-manifest';

/** Claude Code Plugin 清单相对于安装根的固定路径。 */
export const PLUGIN_MANIFEST_PATH = '.claude-plugin/plugin.json';

/** Claude Code Marketplace 清单相对于 Distribution 根的固定路径。 */
export const MARKETPLACE_MANIFEST_PATH = '.claude-plugin/marketplace.json';

/** Marketplace 名称允许使用的小写 kebab-case 规则。 */
const MARKETPLACE_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** 校验可选字符串字段，避免空白展示值进入 Marketplace 清单。 */
function assertOptionalString(value: unknown, field: string): void {
  if (value !== undefined && (typeof value !== 'string' || value.trim().length === 0))
    throw new TypeError(`Claude Code ${field} must be a non-empty string.`);
}

/** 在 Platform 工厂边界校验 Marketplace 选项。 */
export function validateMarketplaceOptions(marketplace: ClaudeCodeMarketplaceOptions | undefined): void {
  if (marketplace === undefined)
    return;
  /** allowed 是 Marketplace 唯一公开选项集合。 */
  const allowed = new Set(['name', 'owner', 'category', 'tags']);
  for (const field of Object.keys(marketplace)) {
    if (!allowed.has(field))
      throw new TypeError(`Unknown Claude Code marketplace option "${field}".`);
  }
  assertOptionalString(marketplace.name, 'marketplace.name');
  if (marketplace.name !== undefined && !MARKETPLACE_NAME_PATTERN.test(marketplace.name))
    throw new TypeError('Claude Code marketplace.name must use lowercase kebab-case.');
  if (marketplace.owner !== undefined) {
    /** ownerFields 是 Marketplace owner 唯一支持的身份字段。 */
    const ownerFields = new Set(['name', 'email', 'url']);
    for (const field of Object.keys(marketplace.owner)) {
      if (!ownerFields.has(field))
        throw new TypeError(`Unknown Claude Code marketplace.owner option "${field}".`);
    }
    assertOptionalString(marketplace.owner.name, 'marketplace.owner.name');
    assertOptionalString(marketplace.owner.email, 'marketplace.owner.email');
    assertOptionalString(marketplace.owner.url, 'marketplace.owner.url');
  }
  assertOptionalString(marketplace.category, 'marketplace.category');
  if (marketplace.tags !== undefined
    && (!Array.isArray(marketplace.tags)
      || marketplace.tags.some(tag => typeof tag !== 'string' || tag.trim().length === 0)
      || new Set(marketplace.tags).size !== marketplace.tags.length)) {
    throw new TypeError('Claude Code marketplace.tags must contain unique non-empty strings.');
  }
}

/** 校验 Claude Code Platform 工厂只接收公开声明的选项。 */
export function validatePlatformOptions(options: ClaudeCodePlatformOptions): void {
  /** allowed 是工厂唯一公开顶层选项集合。 */
  const allowed = new Set(['strict', 'defaultEnabled', 'marketplace']);
  for (const field of Object.keys(options)) {
    if (!allowed.has(field))
      throw new TypeError(`Unknown Claude Code Platform option "${field}".`);
  }
  if (options.strict !== undefined && typeof options.strict !== 'boolean')
    throw new TypeError('Claude Code strict must be a boolean.');
  if (options.defaultEnabled !== undefined && typeof options.defaultEnabled !== 'boolean')
    throw new TypeError('Claude Code defaultEnabled must be a boolean.');
  validateMarketplaceOptions(options.marketplace);
}

/** @returns 统一元数据和 Component 集合对应的原生 Claude Code 清单。 */
function pluginManifest(
  metadata: PluginMetadata,
  options: Readonly<JsonObject>,
  components: { readonly commands: number; readonly skills: number },
): ClaudeCodePluginManifest {
  return {
    name: metadata.name,
    version: metadata.version,
    description: metadata.description,
    ...(metadata.displayName === undefined ? {} : { displayName: metadata.displayName }),
    ...(metadata.author === undefined ? {} : { author: metadata.author }),
    ...(metadata.homepage === undefined ? {} : { homepage: metadata.homepage }),
    ...(metadata.repository === undefined ? {} : { repository: metadata.repository }),
    ...(metadata.license === undefined ? {} : { license: metadata.license }),
    ...(metadata.keywords.length === 0 ? {} : { keywords: metadata.keywords }),
    ...(options.defaultEnabled === undefined ? {} : { defaultEnabled: options.defaultEnabled as boolean }),
    ...(components.commands === 0 ? {} : { commands: './commands/' }),
    ...(components.skills === 0 ? {} : { skills: './skills/' }),
  };
}

/** @returns 当前工程全部实际元数据字段的完整 emitted disposition。 */
function metadataDispositions(metadata: PluginMetadata): readonly MetadataDispositionInput[] {
  /** fields 与 Core metadata coverage 使用相同的规范字段粒度。 */
  const fields = ['name', 'version', 'description'];
  for (const field of ['displayName', 'homepage', 'repository', 'license'] as const) {
    if (metadata[field] !== undefined)
      fields.push(field);
  }
  if (metadata.author !== undefined) {
    fields.push('author.name');
    if (metadata.author.email !== undefined)
      fields.push('author.email');
    if (metadata.author.url !== undefined)
      fields.push('author.url');
  }
  if (metadata.keywords.length > 0)
    fields.push('keywords');
  return Object.freeze(fields.map(field => Object.freeze({
    field,
    disposition: 'emitted' as const,
    output: `${PLUGIN_MANIFEST_PATH}/${field}`,
    reason: `Claude Code plugin.json supports ${field}.`,
  })));
}

/** 创建由 Core codec 序列化、只开放 Hooks/MCP 字段的 Plugin Document。 */
export function createPluginDocument(input: {
  readonly metadata: PluginMetadata;
  readonly options: Readonly<JsonObject>;
  readonly components: { readonly commands: number; readonly skills: number };
}): { readonly document: PackageDocumentInput; readonly metadata: readonly MetadataDispositionInput[] } {
  /** document 是 Platform 唯一拥有的结构化主清单。 */
  const document: PackageDocumentInput = Object.freeze({
    id: PLUGIN_MANIFEST_ID,
    path: PLUGIN_MANIFEST_PATH,
    format: 'json',
    value: pluginManifest(input.metadata, input.options, input.components) as unknown as JsonObject,
    extensionPoints: Object.freeze([
      Object.freeze(['hooks'] as const),
      Object.freeze(['mcpServers'] as const),
    ]),
    /** 合并私有 Component 后才由 Claude Platform 自己决定是否注册 agents 目录。 */
    finalizationPoints: Object.freeze([Object.freeze(['agents'] as const)]),
  });
  return Object.freeze({ document, metadata: metadataDispositions(input.metadata) });
}

/** @returns 统一元数据和显式选项推导出的 Marketplace owner。 */
function marketplaceOwner(
  metadata: PluginMetadata,
  options: ClaudeCodeMarketplaceOptions,
): ClaudeCodeMarketplaceManifest['owner'] {
  if (options.owner !== undefined)
    return options.owner;
  if (metadata.author !== undefined) {
    return {
      name: metadata.author.name,
      ...(metadata.author.email === undefined ? {} : { email: metadata.author.email }),
      ...(metadata.author.url === undefined ? {} : { url: metadata.author.url }),
    };
  }
  return { name: metadata.name };
}

/** @returns 已验证主 Plugin 清单对应的 Marketplace 安装条目。 */
function marketplacePlugin(
  manifest: ClaudeCodePluginManifest,
  options: ClaudeCodeMarketplaceOptions,
): ClaudeCodeMarketplacePlugin {
  return {
    name: manifest.name,
    source: './',
    description: manifest.description,
    version: manifest.version,
    ...(manifest.author === undefined ? {} : { author: manifest.author }),
    ...(manifest.homepage === undefined ? {} : { homepage: manifest.homepage }),
    ...(manifest.repository === undefined ? {} : { repository: manifest.repository }),
    ...(manifest.license === undefined ? {} : { license: manifest.license }),
    ...(manifest.keywords === undefined ? {} : { keywords: manifest.keywords }),
    ...(options.category === undefined ? {} : { category: options.category }),
    ...(options.tags === undefined ? {} : { tags: options.tags }),
    strict: true,
  };
}

/** 从 validated primary 的真实 AssetRef 读取 Plugin 清单。 */
async function readPrimaryManifest(context: DistributionContext): Promise<ClaudeCodePluginManifest> {
  /** manifestAsset 必须来自当前 primary 的固定 Document 输出。 */
  const manifestAsset = context.primary.assets.find(asset => asset.path === PLUGIN_MANIFEST_PATH);
  if (manifestAsset === undefined)
    throw new Error(`Claude Code primary Package is missing ${PLUGIN_MANIFEST_PATH}.`);
  /** value 在读取必填字段前保持未知。 */
  const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(
    await context.assets.read(manifestAsset.asset),
  ));
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Claude Code primary Package has an invalid Plugin Manifest.');
  /** manifest 只在基础身份通过后用于生成 Marketplace 条目。 */
  const manifest = value as Record<string, unknown>;
  if (typeof manifest.name !== 'string' || typeof manifest.version !== 'string' || typeof manifest.description !== 'string')
    throw new Error('Claude Code primary Package has incomplete Plugin metadata.');
  return manifest as unknown as ClaudeCodePluginManifest;
}

/** 从 validated primary 创建保留全部 AssetRef 身份的自包含 Marketplace。 */
export async function createMarketplaceAssets(
  context: DistributionContext,
  options: ClaudeCodeMarketplaceOptions,
): Promise<readonly DistributionAssetInput[]> {
  if (context.primary.assets.some(asset => asset.path === MARKETPLACE_MANIFEST_PATH)) {
    context.diagnostics.report({
      code: 'CLAUDE_MARKETPLACE_PATH_CONFLICT', severity: 'error',
      message: 'The primary Plugin already contains the reserved Marketplace manifest path.',
    });
    return Object.freeze([]);
  }
  /** manifest 是已经过主 Package validator 的真实清单。 */
  const manifest = await readPrimaryManifest(context);
  /** marketplace 只引用当前单一 primary，避免建立第二套多 Package 编排语义。 */
  const marketplace: ClaudeCodeMarketplaceManifest = {
    name: options.name ?? `${context.project.metadata.name}-marketplace`,
    owner: marketplaceOwner(context.project.metadata, options),
    description: context.project.metadata.description,
    version: context.project.metadata.version,
    metadata: { pluginRoot: './' },
    plugins: [marketplacePlugin(manifest, options)],
  };
  /** marketplaceAsset 是 Distribution callback 本次唯一新签发的 Asset。 */
  const marketplaceAsset = await context.assets.fromBytes({
    bytes: stableJson(marketplace as unknown as JsonObject),
    origin: { operation: 'marketplace-manifest', subjects: ['distribution:marketplace'] },
  });
  return Object.freeze([
    ...context.primary.assets.map(asset => Object.freeze({ path: asset.path, asset: asset.asset })),
    Object.freeze({ path: MARKETPLACE_MANIFEST_PATH, asset: marketplaceAsset }),
  ]);
}
