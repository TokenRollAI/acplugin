import type {
  JsonObject,
  MetadataDispositionInput,
  PackageDocumentInput,
  PluginMetadata,
} from '@tokenroll/acplugin/sdk';

/** Antigravity Plugin 清单的稳定逻辑 Document ID。 */
export const PLUGIN_MANIFEST_ID = 'plugin-manifest';

/** Antigravity Plugin 清单相对于安装根的固定路径。 */
export const PLUGIN_MANIFEST_PATH = 'plugin.json';

/** 创建 Antigravity Platform 时可声明的公开选项。 */
export interface AntigravityPlatformOptions {
  readonly strict?: boolean;
}

/** 校验 Antigravity Platform 只接受官方文档确认的最小选项。 */
export function validatePlatformOptions(options: AntigravityPlatformOptions): void {
  /** 当前只允许 Core strictness，不暴露猜测的 Manifest 字段。 */
  const allowed = new Set(['strict']);
  for (const field of Object.keys(options)) {
    if (!allowed.has(field))
      throw new TypeError(`Unknown Antigravity Platform option "${field}".`);
  }
  if (options.strict !== undefined && typeof options.strict !== 'boolean')
    throw new TypeError('Antigravity strict must be a boolean.');
}

/** @returns 当前工程实际 metadata 的完整 emitted/omitted disposition。 */
function metadataDispositions(metadata: PluginMetadata): readonly MetadataDispositionInput[] {
  /** name 是公开契约中唯一确认的元数据字段。 */
  const outputs: [string, string | undefined][] = [['name', `${PLUGIN_MANIFEST_PATH}/name`]];
  /** version 与 description 必填但未被官方最小 Manifest 契约确认。 */
  outputs.push(['version', undefined], ['description', undefined]);
  for (const field of ['displayName', 'homepage', 'repository', 'license'] as const) {
    if (metadata[field] !== undefined)
      outputs.push([field, undefined]);
  }
  if (metadata.author !== undefined) {
    outputs.push(['author.name', undefined]);
    if (metadata.author.email !== undefined)
      outputs.push(['author.email', undefined]);
    if (metadata.author.url !== undefined)
      outputs.push(['author.url', undefined]);
  }
  if (metadata.keywords.length > 0)
    outputs.push(['keywords', undefined]);
  return Object.freeze(outputs.map(([field, output]) => Object.freeze({
    field,
    disposition: output === undefined ? 'omitted' as const : 'emitted' as const,
    ...(output === undefined ? {} : { output }),
    reason: output === undefined
      ? `Antigravity's public Plugin Manifest contract has not confirmed ${field}.`
      : 'Antigravity plugin.json publicly documents the name field.',
  })));
}

/** 创建只含官方确认 name 且由 Core codec 序列化的 Plugin Document。 */
export function createPluginDocument(metadata: PluginMetadata): {
  readonly document: PackageDocumentInput;
  readonly metadata: readonly MetadataDispositionInput[];
} {
  /** Antigravity 不需要 Manifest 字段贡献，Hooks/MCP 通过固定根 Asset add-only 交付。 */
  const document: PackageDocumentInput = Object.freeze({
    id: PLUGIN_MANIFEST_ID,
    path: PLUGIN_MANIFEST_PATH,
    format: 'json',
    value: { name: metadata.name } as JsonObject,
    extensionPoints: Object.freeze([]),
  });
  return Object.freeze({ document, metadata: metadataDispositions(metadata) });
}
