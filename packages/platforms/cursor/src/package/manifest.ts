import type {
  CanonicalProject,
  JsonObject,
  MetadataDispositionInput,
  PackageDocumentInput,
  PluginMetadata,
} from '@tokenroll/acplugin/sdk';
import type { CursorPlatformOptions, CursorPluginManifest } from '../types.js';

/** Cursor Plugin 清单的稳定逻辑 Document ID。 */
export const PLUGIN_MANIFEST_ID = 'plugin-manifest';

/** Cursor Plugin 清单相对于安装根的固定路径。 */
export const PLUGIN_MANIFEST_PATH = '.cursor-plugin/plugin.json';

/** Cursor 与 Core 共同采用的完整语义版本规则。 */
export const SEMVER_PATTERN: RegExp = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[\dA-Za-z-]+(?:\.[\dA-Za-z-]+)*)?$/u;

/** @returns 候选是否为非空字符串。 */
function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/** 校验 Cursor Platform 工厂只接收官方 Schema 对应字段。 */
export function validatePlatformOptions(options: CursorPlatformOptions): void {
  /** allowed 是 Cursor 工厂公开且经验证的精确字段集合。 */
  const allowed = new Set(['strict', 'publisher', 'logo', 'category', 'tags', 'minClientVersions']);
  for (const field of Object.keys(options)) {
    if (!allowed.has(field))
      throw new TypeError(`Unknown Cursor Platform option "${field}".`);
  }
  if (options.strict !== undefined && typeof options.strict !== 'boolean')
    throw new TypeError('Cursor strict must be a boolean.');
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
    for (const [client, version] of Object.entries(options.minClientVersions)) {
      if (!isNonEmptyString(client) || typeof version !== 'string' || !SEMVER_PATTERN.test(version))
        throw new TypeError('Cursor minClientVersions must map non-empty client IDs to semantic versions.');
    }
  }
}

/** @returns canonical project 是否包含指定 Component kind。 */
function hasComponents(project: CanonicalProject, kind: 'command' | 'skill' | 'agent'): boolean {
  return kind === 'command'
    ? project.commands.length > 0
    : kind === 'skill'
      ? project.skills.length > 0
      : project.agents.length > 0;
}

/** @returns 统一元数据和 Cursor 选项组成的官方 Plugin Manifest。 */
function pluginManifest(project: CanonicalProject, options: Readonly<JsonObject>): CursorPluginManifest {
  /** metadata 已由 Core config resolver 完整验证。 */
  const metadata = project.metadata;
  return {
    name: metadata.name,
    version: metadata.version,
    description: metadata.description,
    ...(metadata.displayName === undefined ? {} : { displayName: metadata.displayName }),
    ...(metadata.author === undefined
      ? {}
      : {
          author: {
            name: metadata.author.name,
            ...(metadata.author.email === undefined ? {} : { email: metadata.author.email }),
          },
        }),
    ...(metadata.homepage === undefined ? {} : { homepage: metadata.homepage }),
    ...(metadata.repository === undefined ? {} : { repository: metadata.repository }),
    ...(metadata.license === undefined ? {} : { license: metadata.license }),
    ...(metadata.keywords.length === 0 ? {} : { keywords: metadata.keywords }),
    ...(options.publisher === undefined ? {} : { publisher: options.publisher as string }),
    ...(options.logo === undefined ? {} : { logo: options.logo as string }),
    ...(options.category === undefined ? {} : { category: options.category as string }),
    ...(options.tags === undefined ? {} : { tags: options.tags as readonly string[] }),
    ...(options.minClientVersions === undefined
      ? {}
      : {
          minClientVersions: options.minClientVersions as Readonly<Record<string, string>>,
        }),
    ...(hasComponents(project, 'command') ? { commands: './commands/*.md' } : {}),
    ...(hasComponents(project, 'skill') ? { skills: './skills/*/SKILL.md' } : {}),
    ...(hasComponents(project, 'agent') ? { agents: './agents/*.md' } : {}),
  };
}

/** @returns 当前工程实际 metadata 的完整 emitted/omitted disposition。 */
function metadataDispositions(metadata: PluginMetadata): readonly MetadataDispositionInput[] {
  /** outputs 精确对应 Core 使用的字段粒度和最终 Manifest 位置。 */
  const outputs: [string, string | undefined][] = [
    ['name', `${PLUGIN_MANIFEST_PATH}/name`],
    ['version', `${PLUGIN_MANIFEST_PATH}/version`],
    ['description', `${PLUGIN_MANIFEST_PATH}/description`],
  ];
  for (const field of ['displayName', 'homepage', 'repository', 'license'] as const) {
    if (metadata[field] !== undefined)
      outputs.push([field, `${PLUGIN_MANIFEST_PATH}/${field}`]);
  }
  if (metadata.author !== undefined) {
    outputs.push(['author.name', `${PLUGIN_MANIFEST_PATH}/author/name`]);
    if (metadata.author.email !== undefined)
      outputs.push(['author.email', `${PLUGIN_MANIFEST_PATH}/author/email`]);
    if (metadata.author.url !== undefined)
      outputs.push(['author.url', undefined]);
  }
  if (metadata.keywords.length > 0)
    outputs.push(['keywords', `${PLUGIN_MANIFEST_PATH}/keywords`]);
  return Object.freeze(outputs.map(([field, output]) => Object.freeze({
    field,
    disposition: output === undefined ? 'omitted' as const : 'emitted' as const,
    ...(output === undefined ? {} : { output }),
    reason: output === undefined
      ? 'Cursor plugin.json author accepts only name and email.'
      : `Cursor plugin.json supports ${field}.`,
  })));
}

/** 创建由 Core codec 序列化且只开放 Hooks/MCP 的 Cursor Plugin Document。 */
export function createPluginDocument(input: {
  readonly project: CanonicalProject;
  readonly options: Readonly<JsonObject>;
}): { readonly document: PackageDocumentInput; readonly metadata: readonly MetadataDispositionInput[] } {
  /** document 是 Cursor base Package 的唯一结构化清单。 */
  const document: PackageDocumentInput = Object.freeze({
    id: PLUGIN_MANIFEST_ID,
    path: PLUGIN_MANIFEST_PATH,
    format: 'json',
    value: pluginManifest(input.project, input.options) as unknown as JsonObject,
    extensionPoints: Object.freeze([
      Object.freeze(['hooks'] as const),
      Object.freeze(['mcpServers'] as const),
    ]),
  });
  return Object.freeze({ document, metadata: metadataDispositions(input.project.metadata) });
}
