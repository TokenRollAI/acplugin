import type {
  JsonObject,
  MetadataDispositionInput,
  PackageDocumentInput,
  PluginMetadata,
} from '@tokenroll/acplugin/sdk';
import type { OpenCodePlatformOptions, OpenCodeWorkspaceOptions } from '../types.js';

/** OpenCode workspace 配置的稳定逻辑 Document ID。 */
export const WORKSPACE_CONFIG_ID = 'workspace-config';

/** OpenCode workspace 配置相对于交付根的固定路径。 */
export const WORKSPACE_CONFIG_PATH = 'opencode.json';

/** OpenCode 官方 JSON Schema URL。 */
const OPENCODE_SCHEMA_URL = 'https://opencode.ai/config.json';

/** 校验 OpenCode Platform 选项并拒绝任意 workspace 配置透传。 */
export function validatePlatformOptions(options: OpenCodePlatformOptions): void {
  /** Platform 顶层只允许 strict 和受控 workspace 子对象。 */
  const allowed = new Set(['strict', 'workspace']);
  for (const field of Object.keys(options)) {
    if (!allowed.has(field))
      throw new TypeError(`Unknown OpenCode Platform option "${field}".`);
  }
  if (options.strict !== undefined && typeof options.strict !== 'boolean')
    throw new TypeError('OpenCode strict must be a boolean.');
  if (options.workspace !== undefined) {
    if (options.workspace === null || typeof options.workspace !== 'object' || Array.isArray(options.workspace))
      throw new TypeError('OpenCode workspace must be a plain object.');
    for (const field of Object.keys(options.workspace)) {
      if (field !== 'schema')
        throw new TypeError(`Unknown OpenCode workspace option "${field}".`);
    }
    if (options.workspace.schema !== undefined && typeof options.workspace.schema !== 'boolean')
      throw new TypeError('OpenCode workspace.schema must be a boolean.');
  }
}

/** @returns OpenCode workspace 对实际 canonical metadata 的完整 omitted disposition。 */
function metadataDispositions(metadata: PluginMetadata): readonly MetadataDispositionInput[] {
  /** fields 与 Core metadata coverage 使用相同的字段粒度。 */
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
    disposition: 'omitted' as const,
    reason: 'OpenCode delivery is a workspace overlay, not a static Plugin Manifest.',
  })));
}

/** 创建由 Core codec 按需物化且只开放 MCP 根字段的 workspace Document。 */
export function createWorkspaceDocument(input: {
  readonly metadata: PluginMetadata;
  readonly options: Readonly<JsonObject>;
}): { readonly document: PackageDocumentInput; readonly metadata: readonly MetadataDispositionInput[] } {
  /** workspaceOptions 已由工厂边界校验并由 Core 复制冻结。 */
  const workspaceOptions = input.options.workspace as OpenCodeWorkspaceOptions | undefined;
  /** 空对象配合 omit-if-empty 避免覆盖消费项目已有 opencode.json。 */
  const value: JsonObject = workspaceOptions?.schema === true ? { $schema: OPENCODE_SCHEMA_URL } : {};
  /** document 是 OpenCode Platform 唯一拥有的结构化配置。 */
  const document: PackageDocumentInput = Object.freeze({
    id: WORKSPACE_CONFIG_ID,
    path: WORKSPACE_CONFIG_PATH,
    format: 'json',
    value,
    emission: 'omit-if-empty',
    extensionPoints: Object.freeze([Object.freeze(['mcp'] as const)]),
  });
  return Object.freeze({ document, metadata: metadataDispositions(input.metadata) });
}
