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
  type PluginMetadata,
} from '@acplugin/core';
import { hasComponents } from './components.js';
import type {
  ClaudeCodeMarketplaceManifest,
  ClaudeCodeMarketplaceOptions,
  ClaudeCodeMarketplacePlugin,
  ClaudeCodeMarketplacePluginSource,
  ClaudeCodePlatformOptions,
  ClaudeCodePluginManifest,
} from './types.js';

/** Claude Code Plugin 清单的稳定逻辑 Document ID。 */
export const PLUGIN_MANIFEST_ID = 'plugin-manifest';

/** Claude Code Plugin 清单相对于安装根的固定路径。 */
export const PLUGIN_MANIFEST_PATH = '.claude-plugin/plugin.json';

/** Claude Code Marketplace 清单相对于 Distribution 根的固定路径。 */
export const MARKETPLACE_MANIFEST_PATH = '.claude-plugin/marketplace.json';

/** Claude Code Platform 写入 Artifact 时使用的固定 owner。 */
const PLATFORM_OWNER = 'platform:claude-code' as const;

/** Marketplace 名称允许使用的小写 kebab-case 规则。 */
const MARKETPLACE_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * 按 UTF-16 code unit 比较 Claude Code DeliveryUnit ID，不依赖宿主 locale/ICU。
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

/**
 * 校验可选字符串字段，避免空白展示值进入 Marketplace 清单。
 *
 * @param value Platform 工厂收到的未知字符串候选。
 * @param field 用于错误提示的字段名称。
 */
function assertOptionalString(value: unknown, field: string): void {
  if (value !== undefined && (typeof value !== 'string' || value.trim().length === 0))
    throw new TypeError(`Claude Code ${field} must be a non-empty string.`);
}

/**
 * 在 Platform 工厂边界校验 Marketplace 选项。
 *
 * @param marketplace 用户声明的 Marketplace 根级选项。
 */
export function validateMarketplaceOptions(marketplace: ClaudeCodeMarketplaceOptions | undefined): void {
  if (marketplace === undefined)
    return;
  /** Marketplace 类型边界允许的显式字段集合。 */
  const allowed = new Set(['name', 'owner', 'category', 'tags']);
  for (const field of Object.keys(marketplace)) {
    if (!allowed.has(field))
      throw new TypeError(`Unknown Claude Code marketplace option "${field}".`);
  }
  assertOptionalString(marketplace.name, 'marketplace.name');
  if (marketplace.name !== undefined && !MARKETPLACE_NAME_PATTERN.test(marketplace.name))
    throw new TypeError('Claude Code marketplace.name must use lowercase kebab-case.');
  if (marketplace.owner !== undefined) {
    /** Marketplace owner 只允许官方 name、email 与 url 字段。 */
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
  if (marketplace.tags !== undefined) {
    if (!Array.isArray(marketplace.tags)
      || marketplace.tags.some(tag => typeof tag !== 'string' || tag.trim().length === 0)
      || new Set(marketplace.tags).size !== marketplace.tags.length) {
      throw new TypeError('Claude Code marketplace.tags must contain unique non-empty strings.');
    }
  }
}

/**
 * 校验 Claude Code Platform 工厂只接收公开声明的顶层选项。
 *
 * @param options 用户传入且可能来自宽类型变量的 Platform 选项。
 */
export function validatePlatformOptions(options: ClaudeCodePlatformOptions): void {
  /** Claude Code Platform 工厂公开支持的顶层字段集合。 */
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

/**
 * 创建只包含官方字段和实际 Component 引用的 Claude Code Plugin 清单。
 *
 * @param context Platform prepare 阶段的规范工程与报告上下文。
 * @returns 可供 Extension add-only patch 的初始清单。
 */
function createPluginManifest(context: PlatformPrepareContext): ClaudeCodePluginManifest {
  /** 所有平台共享且已由 Core 验证的 Plugin 元数据。 */
  const metadata = context.project.metadata;
  return {
    name: metadata.name,
    version: metadata.version,
    description: metadata.description,
    ...(metadata.displayName === undefined ? {} : { displayName: metadata.displayName }),
    ...(metadata.author === undefined ? {} : { author: metadata.author }),
    ...(metadata.homepage === undefined ? {} : { homepage: metadata.homepage }),
    ...(metadata.repository === undefined ? {} : { repository: metadata.repository }),
    ...(metadata.license === undefined ? {} : { license: metadata.license }),
    ...(metadata.keywords === undefined ? {} : { keywords: metadata.keywords }),
    ...(context.options.defaultEnabled === undefined ? {} : { defaultEnabled: context.options.defaultEnabled as boolean }),
    ...(hasComponents(context.project, 'command') ? { commands: './commands/' } : {}),
    ...(hasComponents(context.project, 'skill') ? { skills: './skills/' } : {}),
    ...(hasComponents(context.project, 'agent') ? { agents: './agents/' } : {}),
  };
}

/**
 * 报告统一元数据在 Claude Code Plugin 清单中的最终去向。
 *
 * @param context Platform prepare 阶段的元数据报告出口。
 */
function reportMetadata(context: PlatformPrepareContext): void {
  /** 当前工程中始终存在并写入清单的必填元数据字段。 */
  const required = ['name', 'version', 'description'] as const;
  for (const field of required) {
    context.reportMetadata({
      field,
      disposition: 'emitted',
      output: `${PLUGIN_MANIFEST_PATH}.${field}`,
      reason: `Claude Code plugin.json supports ${field}.`,
    });
  }
  /** 只有作者实际声明后才需要报告的可选元数据。 */
  const optional = ['displayName', 'author', 'homepage', 'repository', 'license', 'keywords'] as const;
  for (const field of optional) {
    if (context.project.metadata[field] !== undefined) {
      context.reportMetadata({
        field,
        disposition: 'emitted',
        output: `${PLUGIN_MANIFEST_PATH}.${field}`,
        reason: `Claude Code plugin.json supports ${field}.`,
      });
    }
  }
}

/**
 * 创建 Claude Code Platform 的初始 Plugin Manifest Document。
 *
 * @param context Platform prepare 生命周期上下文。
 * @returns 只开放 Hooks 与 MCP 根字段的单一 Document。
 */
export function createManifestDocument(context: PlatformPrepareContext): DraftDocument {
  reportMetadata(context);
  return {
    id: PLUGIN_MANIFEST_ID,
    path: PLUGIN_MANIFEST_PATH,
    format: 'json',
    owner: PLATFORM_OWNER,
    value: createPluginManifest(context) as unknown as JsonObject,
    // 两个扩展点均为根字段空位；Extension 只能新增，不能替换 Platform 已有字段。
    extensionPoints: [['hooks'], ['mcpServers']],
  };
}

/**
 * 将完成 Extension patch 的 Claude Code Document 序列化为 Artifact。
 *
 * @param documents 当前 Platform Draft 中由 Core 冻结的完整文档列表。
 * @returns 包含固定 Plugin 清单路径的序列化 Artifact。
 */
export function serializeDocuments(documents: readonly DraftDocument[]): ArtifactInput[] {
  /** 按逻辑 ID 查找而不是根据物理路径猜测语义的 Plugin 清单。 */
  const manifest = documents.find(document => document.id === PLUGIN_MANIFEST_ID);
  if (!manifest || manifest.path !== PLUGIN_MANIFEST_PATH || manifest.format !== 'json')
    throw new Error('Claude Code Platform Draft is missing its canonical Plugin Manifest Document.');
  if (documents.length !== 1)
    throw new Error('Claude Code Platform received an unknown Document.');
  return [bytesArtifact(PLUGIN_MANIFEST_PATH, stableJson(manifest.value))];
}

/**
 * 从统一元数据和显式 Marketplace 选项推导 Marketplace owner。
 *
 * @param metadata 规范 Plugin 元数据。
 * @param options 用户声明的 Claude Code Marketplace 选项。
 * @returns 满足 Marketplace 必填字段的所有者身份。
 */
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

/** 一个已验证主单元在 Marketplace Distribution 中的稳定布局。 */
interface MarketplacePluginLayout {
  readonly unit: DeliveryUnit;
  readonly root: string;
  readonly source: ClaudeCodeMarketplacePluginSource;
}

/**
 * 从已验证主单元读取 Claude Code Plugin 清单。
 *
 * @param unit Marketplace Builder 收到的同平台主单元。
 * @returns 已通过基础身份检查的 Plugin 清单。
 */
async function readPrimaryPluginManifest(unit: DeliveryUnit): Promise<ClaudeCodePluginManifest> {
  /** Platform 主单元中的规范 Plugin Manifest Artifact。 */
  const artifact = unit.artifacts.find(candidate => candidate.path === PLUGIN_MANIFEST_PATH);
  if (artifact === undefined)
    throw new Error(`Claude Code primary DeliveryUnit "${unit.id}" is missing ${PLUGIN_MANIFEST_PATH}.`);
  /** 内存 Artifact 直接复制字节，文件 Artifact 只读取 Core 已验证的普通文件来源。 */
  const bytes = artifact.source.type === 'bytes'
    ? artifact.source.value
    : await fs.readFile(artifact.source.path);
  /** fatal UTF-8 解码阻止替换字符掩盖损坏的主单元清单。 */
  const source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  /** JSON.parse 结果在读取必填字段前保持 unknown。 */
  const value: unknown = JSON.parse(source);
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`Claude Code primary DeliveryUnit "${unit.id}" has an invalid Plugin Manifest.`);
  /** 经过对象形态检查后的清单候选。 */
  const manifest = value as Record<string, unknown>;
  if (typeof manifest.name !== 'string'
    || typeof manifest.version !== 'string'
    || typeof manifest.description !== 'string') {
    throw new Error(`Claude Code primary DeliveryUnit "${unit.id}" has incomplete Plugin metadata.`);
  }
  return manifest as unknown as ClaudeCodePluginManifest;
}

/**
 * 为一个或多个主单元选择兼容当前单 Plugin 输出的自包含布局。
 *
 * @param primaryUnits 已由 Core 验证的同 Platform 主单元。
 * @returns 单项保持根目录，多项进入 `plugins/<unit-id>/` 的稳定布局。
 */
function marketplaceLayouts(primaryUnits: readonly DeliveryUnit[]): readonly MarketplacePluginLayout[] {
  if (primaryUnits.length === 0)
    throw new Error('Claude Code Marketplace requires at least one validated primary Plugin.');
  /** 按单元 ID 排序，避免未来编排器的集合遍历顺序影响 Marketplace 字节。 */
  const units = [...primaryUnits].sort((left, right) => compareCodeUnits(left.id, right.id));
  if (new Set(units.map(unit => unit.id)).size !== units.length)
    throw new Error('Claude Code Marketplace received duplicate primary DeliveryUnit IDs.');
  if (units.length === 1)
    return [{ unit: units[0]!, root: '', source: './' }];
  return units.map(unit => ({
    unit,
    root: `plugins/${unit.id}`,
    source: `./plugins/${unit.id}`,
  }));
}

/**
 * 从主 Plugin 清单创建一个 Marketplace 安装条目。
 *
 * @param manifest 当前主单元自己的 Plugin 元数据。
 * @param source 当前 Plugin 在 Distribution 根内的相对路径。
 * @param options Marketplace 级展示选项。
 * @returns 与被引用 Plugin Manifest 身份一致的条目。
 */
function createMarketplacePlugin(
  manifest: ClaudeCodePluginManifest,
  source: ClaudeCodeMarketplacePluginSource,
  options: ClaudeCodeMarketplaceOptions,
): ClaudeCodeMarketplacePlugin {
  return {
    name: manifest.name,
    source,
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

/**
 * 创建自包含 Claude Code Marketplace 清单。
 *
 * @param context Platform Distribution 生命周期上下文。
 * @param options 用户声明或空对象触发的 Marketplace 选项。
 * @param plugins 已按 Distribution 布局创建的 Plugin 条目。
 * @returns 包含一个或多个本地 Plugin 的 Marketplace 清单。
 */
export function createMarketplaceManifest(
  context: PlatformDistributionContext,
  options: ClaudeCodeMarketplaceOptions,
  plugins: readonly ClaudeCodeMarketplacePlugin[],
): ClaudeCodeMarketplaceManifest {
  /** Marketplace 根展示信息仍归当前 Platform 工厂上下文所有。 */
  const metadata = context.project.metadata;
  return {
    name: options.name ?? `${metadata.name}-marketplace`,
    owner: marketplaceOwner(metadata, options),
    description: metadata.description,
    version: metadata.version,
    metadata: { pluginRoot: './' },
    plugins,
  };
}

/**
 * 组合已验证主单元并创建完整 Marketplace Distribution Artifact。
 *
 * @param context Platform Distribution 生命周期上下文。
 * @param options 用户声明的 Marketplace 选项。
 * @param primaryUnits 已验证的同 Platform 主单元数组。
 * @returns 自包含 Plugin 内容和固定 Marketplace 清单。
 */
export async function marketplaceArtifacts(
  context: PlatformDistributionContext,
  options: ClaudeCodeMarketplaceOptions,
  primaryUnits: readonly DeliveryUnit[],
): Promise<readonly ArtifactInput[]> {
  /** 当前输入数量对应的兼容布局。 */
  const layouts = marketplaceLayouts(primaryUnits);
  /** Marketplace 中按布局顺序生成的安装条目。 */
  const plugins: ClaudeCodeMarketplacePlugin[] = [];
  /** Distribution 中复用主单元 source 与 mode 的完整 Artifact。 */
  const artifacts: ArtifactInput[] = [];
  /** layout 表示当前主 Plugin 及其 Distribution 安装根。 */
  for (const layout of layouts) {
    /** 当前主单元已经验证的 Plugin Manifest。 */
    const manifest = await readPrimaryPluginManifest(layout.unit);
    plugins.push(createMarketplacePlugin(manifest, layout.source, options));
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
