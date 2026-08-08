import { promises as fs } from 'node:fs';
import {
  bytesArtifact,
  stableJson,
  type ArtifactInput,
  type DeliveryUnit,
  type DraftDocument,
  type JsonObject,
  type PlatformDistributionContext,
  type PlatformPrepareContext,
} from '@acplugin/core';
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
  CodexMarketplaceSource,
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

/** Codex Platform 写入 Artifact 时使用的固定 owner。 */
const PLATFORM_OWNER = 'platform:codex' as const;

/** Codex Marketplace 机器名称采用的保守 kebab-case 规则。 */
const MARKETPLACE_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * 按 UTF-16 code unit 比较 Codex DeliveryUnit ID，不依赖宿主 locale/ICU。
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

/** Codex 官方插件目录当前接受的分类集合。 */
const CATEGORIES = new Set<CodexCategory>(CODEX_CATEGORIES);

/** Codex Marketplace 当前支持的安装策略集合。 */
const INSTALLATION_POLICIES = new Set(CODEX_MARKETPLACE_INSTALLATIONS);

/**
 * 校验可选字符串字段。
 *
 * @param value Platform 工厂收到的未知候选。
 * @param field 用于错误信息的配置路径。
 */
function assertOptionalString(value: unknown, field: string): void {
  if (value !== undefined && (typeof value !== 'string' || value.trim().length === 0))
    throw new TypeError(`Codex ${field} must be a non-empty string.`);
}

/**
 * 拒绝对象中未由公开类型声明的字段。
 *
 * @param value 待检查的配置对象。
 * @param allowed 当前对象层级允许的字段。
 * @param field 配置对象的稳定路径。
 */
function rejectUnknownFields(value: object, allowed: ReadonlySet<string>, field: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key))
      throw new TypeError(`Unknown Codex ${field} option "${key}".`);
  }
}

/**
 * 校验 Codex Plugin `interface` 平台选项。
 *
 * @param options 用户声明的展示选项。
 */
function validateInterfaceOptions(options: CodexInterfaceOptions | undefined): void {
  if (options === undefined)
    return;
  rejectUnknownFields(options, new Set(CODEX_INTERFACE_OPTION_FIELDS), 'interface');
  for (const field of CODEX_INTERFACE_OPTION_FIELDS) {
    /** 当前可选 interface 配置值。 */
    const value = options[field];
    if (value === undefined)
      continue;
    /** 共享纯规则返回的第一个稳定问题。 */
    const issue = codexInterfaceFieldIssue(field, value);
    if (issue !== undefined)
      throw new TypeError(`Codex ${issue.message}`);
  }
}

/**
 * 校验 Codex Marketplace 平台选项。
 *
 * @param options 用户声明的 Marketplace 根级选项。
 */
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

/**
 * 校验 Codex Platform 工厂公开配置。
 *
 * @param options 用户传入且可能来自宽类型变量的平台选项。
 */
export function validatePlatformOptions(options: CodexPlatformOptions): void {
  rejectUnknownFields(options, new Set(['strict', 'interface', 'marketplace']), 'Platform');
  if (options.strict !== undefined && typeof options.strict !== 'boolean')
    throw new TypeError('Codex strict must be a boolean.');
  validateInterfaceOptions(options.interface);
  validateMarketplaceOptions(options.marketplace);
}

/**
 * 根据统一元数据和 Platform 选项创建完整的 Codex 安装界面字段。
 *
 * @param context Platform prepare 生命周期上下文。
 * @returns 未启用展示字段时返回 undefined，否则返回含官方必填项的 interface。
 */
function createPluginInterface(context: PlatformPrepareContext): CodexPluginInterface | undefined {
  /** 用户声明的 Codex 专属展示选项。 */
  const options = context.options.interface as CodexInterfaceOptions | undefined;
  /** 顶层 displayName 必须映射到 Codex interface，即使没有额外平台选项。 */
  if (options === undefined && context.project.metadata.displayName === undefined)
    return undefined;
  /** 统一元数据同时作为缺省展示文案，避免要求作者重复配置。 */
  const metadata = context.project.metadata;
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

/**
 * 创建由 Platform 所有、Extension 只能增量补充的 Codex Plugin 清单。
 *
 * @param context Platform prepare 生命周期上下文。
 * @returns 只包含官方字段和固定 Component 根路径的清单。
 */
function createPluginManifest(context: PlatformPrepareContext): CodexPluginManifest {
  /** 所有 Platform 共享且已经由 Core 校验的统一元数据。 */
  const metadata = context.project.metadata;
  /** 可选的 Codex 安装界面字段。 */
  const pluginInterface = createPluginInterface(context);
  return {
    name: metadata.name,
    version: metadata.version,
    description: metadata.description,
    ...(metadata.author === undefined ? {} : { author: metadata.author }),
    ...(metadata.homepage === undefined ? {} : { homepage: metadata.homepage }),
    ...(metadata.repository === undefined ? {} : { repository: metadata.repository }),
    ...(metadata.license === undefined ? {} : { license: metadata.license }),
    ...(metadata.keywords === undefined ? {} : { keywords: metadata.keywords }),
    skills: './skills/',
    ...(pluginInterface === undefined ? {} : { interface: pluginInterface }),
  };
}

/**
 * 报告统一元数据在 Codex Plugin 清单中的最终去向。
 *
 * @param context Platform prepare 阶段的元数据报告出口。
 */
function reportMetadata(context: PlatformPrepareContext): void {
  /** 直接写入 Manifest 根节点的统一元数据字段。 */
  const rootFields = ['name', 'version', 'description', 'author', 'homepage', 'repository', 'license', 'keywords'] as const;
  for (const field of rootFields) {
    if (field === 'name' || field === 'version' || field === 'description'
      || context.project.metadata[field] !== undefined) {
      context.reportMetadata({
        field,
        disposition: 'emitted',
        output: `${PLUGIN_MANIFEST_PATH}.${field}`,
        reason: `Codex plugin.json supports ${field}.`,
      });
    }
  }
  if (context.project.metadata.displayName !== undefined) {
    context.reportMetadata({
      field: 'displayName',
      disposition: 'emitted',
      output: `${PLUGIN_MANIFEST_PATH}.interface.displayName`,
      reason: 'Codex exposes the unified displayName through its install interface.',
    });
  }
}

/**
 * 创建 Codex Platform 的初始 Plugin Manifest Document。
 *
 * @param context Platform prepare 生命周期上下文。
 * @returns 只开放 Hooks 与 MCP 根字段的单一 Document。
 */
export function createManifestDocument(context: PlatformPrepareContext): DraftDocument {
  reportMetadata(context);
  if (!hasGeneratedSkills(context.project)) {
    context.reportDiagnostic({
      code: 'CODEX_SKILL_REQUIRED',
      severity: 'error',
      message: 'A Codex Plugin must contain at least one native or generated Skill.',
    });
  }
  return {
    id: PLUGIN_MANIFEST_ID,
    path: PLUGIN_MANIFEST_PATH,
    format: 'json',
    owner: PLATFORM_OWNER,
    value: createPluginManifest(context) as unknown as JsonObject,
    // Extension 只能填充 Platform 预留的官方根字段，不能覆盖身份、Skills 或 interface。
    extensionPoints: [['hooks'], ['mcpServers']],
  };
}

/**
 * 将完成 Extension patch 的 Codex Document 序列化为 Artifact。
 *
 * @param documents 当前 Platform Draft 中由 Core 冻结的完整文档列表。
 * @returns 包含固定 Plugin 清单路径的序列化 Artifact。
 */
export function serializeDocuments(documents: readonly DraftDocument[]): ArtifactInput[] {
  /** 按逻辑 ID 查找而不是从物理路径猜测语义的 Plugin 清单。 */
  const manifest = documents.find(document => document.id === PLUGIN_MANIFEST_ID);
  if (!manifest || manifest.path !== PLUGIN_MANIFEST_PATH || manifest.format !== 'json')
    throw new Error('Codex Platform Draft is missing its canonical Plugin Manifest Document.');
  if (documents.length !== 1)
    throw new Error('Codex Platform received an unknown Document.');
  return [bytesArtifact(PLUGIN_MANIFEST_PATH, stableJson(manifest.value))];
}

/** 一个已验证主单元在 Codex Marketplace 中的稳定布局。 */
interface MarketplacePluginLayout {
  readonly unit: DeliveryUnit;
  readonly root: string;
  readonly source: CodexMarketplaceSource;
}

/**
 * 从已验证主单元读取 Codex Plugin 清单。
 *
 * @param unit Marketplace Builder 收到的同平台主单元。
 * @returns 已通过基础身份检查的 Plugin 清单。
 */
async function readPrimaryPluginManifest(unit: DeliveryUnit): Promise<CodexPluginManifest> {
  /** Platform 主单元中的规范 Plugin Manifest Artifact。 */
  const artifact = unit.artifacts.find(candidate => candidate.path === PLUGIN_MANIFEST_PATH);
  if (artifact === undefined)
    throw new Error(`Codex primary DeliveryUnit "${unit.id}" is missing ${PLUGIN_MANIFEST_PATH}.`);
  /** 内存 Artifact 直接复制字节，文件 Artifact 只读取 Core 已验证的普通文件来源。 */
  const bytes = artifact.source.type === 'bytes'
    ? artifact.source.value
    : await fs.readFile(artifact.source.path);
  /** fatal UTF-8 解码阻止替换字符掩盖损坏的主单元清单。 */
  const source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  /** JSON.parse 结果在读取必填字段前保持 unknown。 */
  const value: unknown = JSON.parse(source);
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`Codex primary DeliveryUnit "${unit.id}" has an invalid Plugin Manifest.`);
  /** 经过对象形态检查后的清单候选。 */
  const manifest = value as Record<string, unknown>;
  if (typeof manifest.name !== 'string'
    || typeof manifest.version !== 'string'
    || typeof manifest.description !== 'string') {
    throw new Error(`Codex primary DeliveryUnit "${unit.id}" has incomplete Plugin metadata.`);
  }
  return manifest as unknown as CodexPluginManifest;
}

/**
 * 为一个或多个主单元选择兼容当前单 Plugin 输出的 Codex 布局。
 *
 * @param primaryUnits 已由 Core 验证的同 Platform 主单元。
 * @returns 单项保持根目录，多项进入 `plugins/<unit-id>/` 的稳定布局。
 */
function marketplaceLayouts(primaryUnits: readonly DeliveryUnit[]): readonly MarketplacePluginLayout[] {
  if (primaryUnits.length === 0)
    throw new Error('Codex Marketplace requires at least one validated primary Plugin.');
  /** 按单元 ID 排序，避免未来编排器的集合遍历顺序影响 Marketplace 字节。 */
  const units = [...primaryUnits].sort((left, right) => compareCodeUnits(left.id, right.id));
  if (new Set(units.map(unit => unit.id)).size !== units.length)
    throw new Error('Codex Marketplace received duplicate primary DeliveryUnit IDs.');
  if (units.length === 1)
    return [{ unit: units[0]!, root: '', source: { source: 'local', path: './' } }];
  return units.map(unit => ({
    unit,
    root: `plugins/${unit.id}`,
    source: { source: 'local', path: `./plugins/${unit.id}` },
  }));
}

/**
 * 创建一个 Codex Marketplace Plugin 条目。
 *
 * @param manifest 当前主单元自己的 Plugin 元数据。
 * @param source 当前 Plugin 在 Distribution 根内的本地来源。
 * @param context Platform Distribution 生命周期上下文。
 * @param options Marketplace 级展示与安装选项。
 * @returns 与被引用 Plugin Manifest 身份一致的条目。
 */
function createMarketplacePlugin(
  manifest: CodexPluginManifest,
  source: CodexMarketplaceSource,
  context: PlatformDistributionContext,
  options: CodexMarketplaceOptions,
): CodexMarketplacePlugin {
  /** Platform interface 可为全部 Marketplace 条目提供缺省分类。 */
  const pluginInterface = context.options.interface as CodexInterfaceOptions | undefined;
  return {
    name: manifest.name,
    source,
    policy: {
      installation: options.policy?.installation ?? 'AVAILABLE',
      authentication: 'ON_INSTALL',
    },
    category: options.category ?? pluginInterface?.category ?? 'Other',
  };
}

/**
 * 创建自包含 Codex Marketplace 清单。
 *
 * @param context Platform Distribution 生命周期上下文。
 * @param options 用户声明或空对象触发的 Marketplace 选项。
 * @param plugins 已按 Distribution 布局创建的 Plugin 条目。
 * @returns 可直接放入 Repo Marketplace 位置的清单。
 */
export function createMarketplaceManifest(
  context: PlatformDistributionContext,
  options: CodexMarketplaceOptions,
  plugins: readonly CodexMarketplacePlugin[],
): CodexMarketplaceManifest {
  /** Marketplace 根展示信息仍归当前 Platform 工厂上下文所有。 */
  const metadata = context.project.metadata;
  return {
    name: options.name ?? `${metadata.name}-marketplace`,
    interface: {
      displayName: options.displayName ?? `${metadata.displayName ?? metadata.name} Marketplace`,
    },
    plugins,
  };
}

/**
 * 组合已验证主单元并创建完整 Codex Marketplace Distribution Artifact。
 *
 * @param context Platform Distribution 生命周期上下文。
 * @param options 用户声明的 Marketplace 选项。
 * @param primaryUnits 已验证的同 Platform 主单元数组。
 * @returns 自包含 Plugin 内容和固定 Marketplace 清单。
 */
export async function marketplaceArtifacts(
  context: PlatformDistributionContext,
  options: CodexMarketplaceOptions,
  primaryUnits: readonly DeliveryUnit[],
): Promise<readonly ArtifactInput[]> {
  /** 当前输入数量对应的兼容布局。 */
  const layouts = marketplaceLayouts(primaryUnits);
  /** Marketplace 中按布局顺序生成的安装条目。 */
  const plugins: CodexMarketplacePlugin[] = [];
  /** Distribution 中复用主单元 source 与 mode 的完整 Artifact。 */
  const artifacts: ArtifactInput[] = [];
  /** layout 表示当前主 Plugin 及其 Distribution 安装根。 */
  for (const layout of layouts) {
    /** 当前主单元已经验证的 Plugin Manifest。 */
    const manifest = await readPrimaryPluginManifest(layout.unit);
    plugins.push(createMarketplacePlugin(manifest, layout.source, context, options));
    /** artifact 表示当前 Plugin 要原样复制的文件。 */
    for (const artifact of layout.unit.artifacts) {
      artifacts.push({
        path: layout.root === '' ? artifact.path : `${layout.root}/${artifact.path}`,
        source: artifact.source,
        mode: artifact.mode,
      });
    }
  }
  artifacts.push(bytesArtifact(
    MARKETPLACE_MANIFEST_PATH,
    stableJson(createMarketplaceManifest(context, options, plugins)),
  ));
  return artifacts;
}
