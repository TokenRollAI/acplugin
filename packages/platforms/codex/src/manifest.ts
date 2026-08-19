import {
  stableJson,
  type CanonicalProject,
  type DistributionAssetInput,
  type DistributionContext,
  type JsonObject,
  type MetadataDispositionInput,
  type PackageDocumentInput,
  type PluginMetadata,
} from '@tokenroll/acplugin/sdk';
import { hasGeneratedSkills } from './components.js';
import {
  CODEX_CATEGORIES,
  CODEX_INTERFACE_OPTION_FIELDS,
  CODEX_MARKETPLACE_INSTALLATIONS,
  codexInterfaceFieldIssue,
} from './protocol.js';
import type {
  CodexCategory,
  CodexInterfaceOptions,
  CodexMarketplaceManifest,
  CodexMarketplaceOptions,
  CodexMarketplacePlugin,
  CodexPlatformOptions,
  CodexPluginInterface,
  CodexPluginManifest,
} from './types.js';

/** Codex Plugin 清单的稳定逻辑 Document ID。 */
export const PLUGIN_MANIFEST_ID = 'plugin-manifest';

/** Codex Plugin 清单相对于安装根的官方固定路径。 */
export const PLUGIN_MANIFEST_PATH = '.codex-plugin/plugin.json';

/** Codex Repo Marketplace 清单相对于 Distribution 根的官方固定路径。 */
export const MARKETPLACE_MANIFEST_PATH = '.agents/plugins/marketplace.json';

/** Codex Marketplace 机器名称采用的保守 kebab-case 规则。 */
const MARKETPLACE_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Codex 官方插件目录当前接受的分类集合。 */
const CATEGORIES = new Set<CodexCategory>(CODEX_CATEGORIES);

/** Codex Marketplace 当前支持的安装策略集合。 */
const INSTALLATION_POLICIES = new Set(CODEX_MARKETPLACE_INSTALLATIONS);

/** 校验可选字符串字段。 */
function assertOptionalString(value: unknown, field: string): void {
  if (value !== undefined && (typeof value !== 'string' || value.trim().length === 0))
    throw new TypeError(`Codex ${field} must be a non-empty string.`);
}

/** 拒绝配置对象中的未知字段。 */
function rejectUnknownFields(value: object, allowed: ReadonlySet<string>, field: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key))
      throw new TypeError(`Unknown Codex ${field} option "${key}".`);
  }
}

/** 校验 Codex Plugin interface 平台选项。 */
function validateInterfaceOptions(options: CodexInterfaceOptions | undefined): void {
  if (options === undefined)
    return;
  rejectUnknownFields(options, new Set(CODEX_INTERFACE_OPTION_FIELDS), 'interface');
  for (const field of CODEX_INTERFACE_OPTION_FIELDS) {
    /** value 是当前可选 interface 配置。 */
    const value = options[field];
    if (value === undefined)
      continue;
    /** issue 复用最终 validator 的纯协议规则。 */
    const issue = codexInterfaceFieldIssue(field, value);
    if (issue !== undefined)
      throw new TypeError(`Codex ${issue.message}`);
  }
}

/** 校验 Codex Marketplace 选项。 */
function validateMarketplaceOptions(options: CodexMarketplaceOptions | undefined): void {
  if (options === undefined)
    return;
  rejectUnknownFields(options, new Set(['name', 'displayName', 'category', 'policy']), 'marketplace');
  assertOptionalString(options.name, 'marketplace.name');
  assertOptionalString(options.displayName, 'marketplace.displayName');
  if (options.name !== undefined && !MARKETPLACE_NAME_PATTERN.test(options.name))
    throw new TypeError('Codex marketplace.name must use lowercase kebab-case.');
  if (options.category !== undefined && !CATEGORIES.has(options.category))
    throw new TypeError('Codex marketplace.category is not an official Plugin category.');
  if (options.policy !== undefined) {
    rejectUnknownFields(options.policy, new Set(['installation']), 'marketplace.policy');
    if (options.policy.installation !== undefined && !INSTALLATION_POLICIES.has(options.policy.installation))
      throw new TypeError('Codex marketplace.policy.installation is not supported.');
  }
}

/** 校验 Codex Platform 工厂公开配置。 */
export function validatePlatformOptions(options: CodexPlatformOptions): void {
  rejectUnknownFields(options, new Set(['strict', 'interface', 'marketplace']), 'Platform');
  if (options.strict !== undefined && typeof options.strict !== 'boolean')
    throw new TypeError('Codex strict must be a boolean.');
  validateInterfaceOptions(options.interface);
  validateMarketplaceOptions(options.marketplace);
}

/** @returns 统一元数据与 Platform 选项组成的 Codex 安装界面。 */
function pluginInterface(
  metadata: PluginMetadata,
  options: CodexInterfaceOptions | undefined,
): CodexPluginInterface | undefined {
  if (options === undefined && metadata.displayName === undefined)
    return undefined;
  return {
    displayName: metadata.displayName ?? metadata.name,
    shortDescription: options?.shortDescription ?? metadata.description,
    longDescription: options?.longDescription ?? metadata.description,
    developerName: options?.developerName ?? metadata.author?.name ?? metadata.name,
    ...(options?.category === undefined ? {} : { category: options.category }),
    ...(options?.capabilities === undefined ? {} : { capabilities: options.capabilities }),
    ...(options?.websiteURL ?? metadata.homepage) === undefined
      ? {}
      : { websiteURL: options?.websiteURL ?? metadata.homepage! },
    ...(options?.privacyPolicyURL === undefined ? {} : { privacyPolicyURL: options.privacyPolicyURL }),
    ...(options?.termsOfServiceURL === undefined ? {} : { termsOfServiceURL: options.termsOfServiceURL }),
    ...(options?.supportURL === undefined ? {} : { supportURL: options.supportURL }),
    ...(options?.defaultPrompt === undefined ? {} : { defaultPrompt: options.defaultPrompt }),
    ...(options?.brandColor === undefined ? {} : { brandColor: options.brandColor }),
    ...(options?.brandColorDark === undefined ? {} : { brandColorDark: options.brandColorDark }),
    ...(options?.composerIcon === undefined ? {} : { composerIcon: options.composerIcon }),
    ...(options?.logo === undefined ? {} : { logo: options.logo }),
    ...(options?.screenshots === undefined ? {} : { screenshots: options.screenshots }),
  };
}

/** @returns 完整 Codex Plugin 清单。 */
function pluginManifest(
  project: CanonicalProject,
  options: CodexInterfaceOptions | undefined,
): CodexPluginManifest {
  /** metadata 已由 Core config resolver 完整验证。 */
  const metadata = project.metadata;
  /** interfaceValue 只在有实际统一或专属展示字段时存在。 */
  const interfaceValue = pluginInterface(metadata, options);
  return {
    name: metadata.name,
    version: metadata.version,
    description: metadata.description,
    ...(metadata.author === undefined ? {} : { author: metadata.author }),
    ...(metadata.homepage === undefined ? {} : { homepage: metadata.homepage }),
    ...(metadata.repository === undefined ? {} : { repository: metadata.repository }),
    ...(metadata.license === undefined ? {} : { license: metadata.license }),
    ...(metadata.keywords.length === 0 ? {} : { keywords: metadata.keywords }),
    skills: './skills/',
    ...(interfaceValue === undefined ? {} : { interface: interfaceValue }),
  };
}

/** @returns 当前工程实际 metadata 的完整 disposition。 */
function metadataDispositions(metadata: PluginMetadata): readonly MetadataDispositionInput[] {
  /** outputs 为每个字段声明最终 Manifest 位置。 */
  const outputs: [string, string][] = [
    ['name', `${PLUGIN_MANIFEST_PATH}/name`],
    ['version', `${PLUGIN_MANIFEST_PATH}/version`],
    ['description', `${PLUGIN_MANIFEST_PATH}/description`],
  ];
  for (const field of ['homepage', 'repository', 'license'] as const) {
    if (metadata[field] !== undefined)
      outputs.push([field, `${PLUGIN_MANIFEST_PATH}/${field}`]);
  }
  if (metadata.author !== undefined) {
    outputs.push(['author.name', `${PLUGIN_MANIFEST_PATH}/author/name`]);
    if (metadata.author.email !== undefined)
      outputs.push(['author.email', `${PLUGIN_MANIFEST_PATH}/author/email`]);
    if (metadata.author.url !== undefined)
      outputs.push(['author.url', `${PLUGIN_MANIFEST_PATH}/author/url`]);
  }
  if (metadata.keywords.length > 0)
    outputs.push(['keywords', `${PLUGIN_MANIFEST_PATH}/keywords`]);
  if (metadata.displayName !== undefined)
    outputs.push(['displayName', `${PLUGIN_MANIFEST_PATH}/interface/displayName`]);
  return Object.freeze(outputs.map(([field, output]) => Object.freeze({
    field, disposition: 'emitted' as const, output,
    reason: `Codex plugin.json supports ${field}.`,
  })));
}

/** 创建由 Core codec 序列化、只开放 Hooks/MCP 的 Plugin Document。 */
export function createPluginDocument(input: {
  readonly project: CanonicalProject;
  readonly options: Readonly<JsonObject>;
  readonly diagnostics: { readonly report: (input: { readonly code: string; readonly severity: 'error'; readonly message: string }) => void };
}): { readonly document: PackageDocumentInput; readonly metadata: readonly MetadataDispositionInput[] } {
  if (!hasGeneratedSkills(input.project)) {
    input.diagnostics.report({
      code: 'CODEX_SKILL_REQUIRED', severity: 'error',
      message: 'A Codex Plugin must contain at least one native or generated Skill.',
    });
  }
  /** interfaceOptions 来自 Platform session 深冻 JSON 副本。 */
  const interfaceOptions = input.options.interface as CodexInterfaceOptions | undefined;
  /** document 是 Codex base Package 的唯一结构化清单。 */
  const document: PackageDocumentInput = Object.freeze({
    id: PLUGIN_MANIFEST_ID,
    path: PLUGIN_MANIFEST_PATH,
    format: 'json',
    value: pluginManifest(input.project, interfaceOptions) as unknown as JsonObject,
    extensionPoints: Object.freeze([
      Object.freeze(['hooks'] as const),
      Object.freeze(['mcpServers'] as const),
    ]),
  });
  return Object.freeze({ document, metadata: metadataDispositions(input.project.metadata) });
}

/** @returns 一个 single-primary Marketplace Plugin 条目。 */
function marketplacePlugin(
  manifest: CodexPluginManifest,
  options: CodexMarketplaceOptions,
  interfaceOptions: CodexInterfaceOptions | undefined,
): CodexMarketplacePlugin {
  return {
    name: manifest.name,
    source: { source: 'local', path: './' },
    policy: {
      installation: options.policy?.installation ?? 'AVAILABLE',
      authentication: 'ON_INSTALL',
    },
    category: options.category ?? interfaceOptions?.category ?? 'Other',
  };
}

/** 从已验证 primary 的真实 AssetRef 读取 Plugin 清单。 */
async function readPrimaryManifest(context: DistributionContext): Promise<CodexPluginManifest> {
  /** manifestAsset 必须命中 Core codec 创建的固定路径。 */
  const manifestAsset = context.primary.assets.find(asset => asset.path === PLUGIN_MANIFEST_PATH);
  if (manifestAsset === undefined)
    throw new Error(`Codex primary Package is missing ${PLUGIN_MANIFEST_PATH}.`);
  /** value 在读取必填字段前保持未知。 */
  const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(
    await context.assets.read(manifestAsset.asset),
  ));
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Codex primary Package has an invalid Plugin Manifest.');
  /** manifest 只在三个身份字段完成检查后进入 Marketplace。 */
  const manifest = value as Record<string, unknown>;
  if (typeof manifest.name !== 'string' || typeof manifest.version !== 'string' || typeof manifest.description !== 'string')
    throw new Error('Codex primary Package has incomplete Plugin metadata.');
  return manifest as unknown as CodexPluginManifest;
}

/** 从 validated primary 创建保留全部 AssetRef 身份的 Codex Marketplace。 */
export async function createMarketplaceAssets(
  context: DistributionContext,
  options: CodexMarketplaceOptions,
  interfaceOptions: CodexInterfaceOptions | undefined,
): Promise<readonly DistributionAssetInput[]> {
  if (context.primary.assets.some(asset => asset.path === MARKETPLACE_MANIFEST_PATH)) {
    context.diagnostics.report({
      code: 'CODEX_MARKETPLACE_PATH_CONFLICT', severity: 'error',
      message: 'The primary Plugin already contains the reserved Marketplace manifest path.',
    });
    return Object.freeze([]);
  }
  /** manifest 已通过 primary candidate validator。 */
  const manifest = await readPrimaryManifest(context);
  /** marketplace 只表达当前 BuildSession 的单一 primary。 */
  const marketplace: CodexMarketplaceManifest = {
    name: options.name ?? `${context.project.metadata.name}-marketplace`,
    interface: {
      displayName: options.displayName ?? `${context.project.metadata.displayName ?? context.project.metadata.name} Marketplace`,
    },
    plugins: [marketplacePlugin(manifest, options, interfaceOptions)],
  };
  /** marketplaceAsset 是本 Distribution callback 唯一新签发的 bytes。 */
  const marketplaceAsset = await context.assets.fromBytes({
    bytes: stableJson(marketplace as unknown as JsonObject),
    origin: { operation: 'marketplace-manifest', subjects: ['distribution:marketplace'] },
  });
  return Object.freeze([
    ...context.primary.assets.map(asset => Object.freeze({ path: asset.path, asset: asset.asset })),
    Object.freeze({ path: MARKETPLACE_MANIFEST_PATH, asset: marketplaceAsset }),
  ]);
}
