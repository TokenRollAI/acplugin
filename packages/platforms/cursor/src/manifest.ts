import {
  bytesArtifact,
  stableJson,
  type ArtifactInput,
  type DraftDocument,
  type JsonObject,
  type PlatformPrepareContext,
} from '@acplugin/core';
import { hasComponents } from './components.js';
import type { CursorPlatformOptions, CursorPluginManifest } from './types.js';

/** Cursor Plugin 清单的稳定逻辑 Document ID。 */
export const PLUGIN_MANIFEST_ID = 'plugin-manifest';

/** Cursor Plugin 清单相对于安装根的固定路径。 */
export const PLUGIN_MANIFEST_PATH = '.cursor-plugin/plugin.json';

/** Cursor Platform 写入 Artifact 时使用的固定 owner。 */
const PLATFORM_OWNER = 'platform:cursor' as const;

/** Cursor 与 Core 共同采用的完整语义版本规则。 */
export const SEMVER_PATTERN: RegExp = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[\dA-Za-z-]+(?:\.[\dA-Za-z-]+)*)?$/u;

/**
 * 判断值是否为非空字符串。
 *
 * @param value Platform 工厂收到的未知候选。
 * @returns 可安全进入官方 Manifest 时返回 true。
 */
function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * 校验 Cursor Platform 工厂只接收官方 Schema 对应字段。
 *
 * @param options 用户声明的 Cursor Platform 选项。
 */
export function validatePlatformOptions(options: CursorPlatformOptions): void {
  /** Cursor Platform 对外开放的精确顶层字段。 */
  const allowed = new Set(['strict', 'publisher', 'logo', 'category', 'tags', 'minClientVersions']);
  for (const field of Object.keys(options)) {
    if (!allowed.has(field))
      throw new TypeError(`Unknown Cursor Platform option "${field}".`);
  }
  if (options.strict !== undefined && typeof options.strict !== 'boolean')
    throw new TypeError('Cursor strict must be a boolean.');
  /** field 表示当前可选普通字符串配置。 */
  for (const field of ['publisher', 'logo', 'category'] as const) {
    if (options[field] !== undefined && !isNonEmptyString(options[field]))
      throw new TypeError(`Cursor ${field} must be a non-empty string.`);
  }
  if (options.tags !== undefined
    && (!Array.isArray(options.tags)
      || options.tags.some(tag => !isNonEmptyString(tag))
      || new Set(options.tags).size !== options.tags.length)) {
    throw new TypeError('Cursor tags must contain unique non-empty strings.');
  }
  if (options.minClientVersions !== undefined) {
    if (options.minClientVersions === null || typeof options.minClientVersions !== 'object'
      || Array.isArray(options.minClientVersions) || Object.keys(options.minClientVersions).length === 0) {
      throw new TypeError('Cursor minClientVersions must be a non-empty object.');
    }
    /** [client, version] 表示当前最低客户端版本约束。 */
    for (const [client, version] of Object.entries(options.minClientVersions)) {
      if (!isNonEmptyString(client) || typeof version !== 'string' || !SEMVER_PATTERN.test(version))
        throw new TypeError('Cursor minClientVersions must map non-empty client IDs to semantic versions.');
    }
  }
}

/**
 * 创建只包含官方字段和实际 Component Glob 的 Cursor Plugin 清单。
 *
 * @param context Platform prepare 阶段的规范工程与报告上下文。
 * @returns 可供 Extension add-only patch 的初始清单。
 */
function createPluginManifest(context: PlatformPrepareContext): CursorPluginManifest {
  /** 所有平台共享且已由 Core 验证的 Plugin 元数据。 */
  const metadata = context.project.metadata;
  return {
    name: metadata.name,
    version: metadata.version,
    description: metadata.description,
    ...(metadata.displayName === undefined ? {} : { displayName: metadata.displayName }),
    ...(metadata.author === undefined
      ? {}
      : { author: { name: metadata.author.name, ...(metadata.author.email === undefined ? {} : { email: metadata.author.email }) } }),
    ...(metadata.homepage === undefined ? {} : { homepage: metadata.homepage }),
    ...(metadata.repository === undefined ? {} : { repository: metadata.repository }),
    ...(metadata.license === undefined ? {} : { license: metadata.license }),
    ...(metadata.keywords === undefined ? {} : { keywords: metadata.keywords }),
    ...(context.options.publisher === undefined ? {} : { publisher: context.options.publisher as string }),
    ...(context.options.logo === undefined ? {} : { logo: context.options.logo as string }),
    ...(context.options.category === undefined ? {} : { category: context.options.category as string }),
    ...(context.options.tags === undefined ? {} : { tags: context.options.tags as readonly string[] }),
    ...(context.options.minClientVersions === undefined
      ? {}
      : { minClientVersions: context.options.minClientVersions as Readonly<Record<string, string>> }),
    ...(hasComponents(context.project, 'command') ? { commands: './commands/*.md' } : {}),
    ...(hasComponents(context.project, 'skill') ? { skills: './skills/*/SKILL.md' } : {}),
    ...(hasComponents(context.project, 'agent') ? { agents: './agents/*.md' } : {}),
  };
}

/**
 * 报告统一元数据在 Cursor Plugin 清单中的最终去向。
 *
 * @param context Platform prepare 阶段的元数据报告出口。
 */
function reportMetadata(context: PlatformPrepareContext): void {
  /** 当前工程中始终存在并写入清单的必填元数据字段。 */
  const required = ['name', 'version', 'description'] as const;
  /** field 表示当前必填字段，用于报告稳定输出位置。 */
  for (const field of required) {
    context.reportMetadata({
      field,
      disposition: 'emitted',
      output: `${PLUGIN_MANIFEST_PATH}.${field}`,
      reason: `Cursor plugin.json supports ${field}.`,
    });
  }
  /** Cursor 原生输出的统一可选元数据。 */
  const emitted = ['displayName', 'homepage', 'repository', 'license', 'keywords'] as const;
  /** field 表示当前实际声明的可选字段。 */
  for (const field of emitted) {
    if (context.project.metadata[field] !== undefined) {
      context.reportMetadata({
        field,
        disposition: 'emitted',
        output: `${PLUGIN_MANIFEST_PATH}.${field}`,
        reason: `Cursor plugin.json supports ${field}.`,
      });
    }
  }
  if (context.project.metadata.author !== undefined) {
    context.reportMetadata({
      field: 'author',
      disposition: 'emitted',
      output: `${PLUGIN_MANIFEST_PATH}.author`,
      reason: 'Cursor plugin.json supports author name and email.',
    });
    if (context.project.metadata.author.url !== undefined) {
      context.reportDiagnostic({
        code: 'CURSOR_METADATA_AUTHOR_URL_OMITTED',
        severity: 'warning',
        message: 'Cursor author.url is omitted because the official author Schema accepts only name and email.',
        fieldPath: ['author', 'url'],
      });
    }
  }
}

/**
 * 创建 Cursor Platform 的初始 Plugin Manifest Document。
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
    extensionPoints: [['hooks'], ['mcpServers']],
  };
}

/**
 * 将完成 Extension patch 的 Cursor Document 序列化为 Artifact。
 *
 * @param documents 当前 Platform Draft 中由 Core 冻结的完整文档列表。
 * @returns 包含固定 Plugin 清单路径的序列化 Artifact。
 */
export function serializeDocuments(documents: readonly DraftDocument[]): ArtifactInput[] {
  /** 按逻辑 ID 查找而不是根据物理路径猜测语义的 Plugin 清单。 */
  const manifest = documents.find(document => document.id === PLUGIN_MANIFEST_ID);
  if (!manifest || manifest.path !== PLUGIN_MANIFEST_PATH || manifest.format !== 'json')
    throw new Error('Cursor Platform Draft is missing its canonical Plugin Manifest Document.');
  if (documents.length !== 1)
    throw new Error('Cursor Platform received an unknown Document.');
  return [bytesArtifact(PLUGIN_MANIFEST_PATH, stableJson(manifest.value))];
}
