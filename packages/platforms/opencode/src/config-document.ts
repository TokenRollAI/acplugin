import {
  bytesArtifact,
  stableJson,
  type ArtifactInput,
  type DraftDocument,
  type JsonObject,
  type PlatformPrepareContext,
} from '@tokenroll/acplugin';
import type { OpenCodePlatformOptions, OpenCodeWorkspaceOptions } from './types.js';

/** OpenCode workspace 配置的稳定逻辑 Document ID。 */
export const WORKSPACE_CONFIG_ID = 'workspace-config';

/** OpenCode workspace 配置相对于交付根的固定路径。 */
export const WORKSPACE_CONFIG_PATH = 'opencode.json';

/** OpenCode Platform 写入 Document 时使用的固定 owner。 */
const PLATFORM_OWNER = 'platform:opencode' as const;

/** OpenCode 官方 JSON Schema URL。 */
const OPENCODE_SCHEMA_URL = 'https://opencode.ai/config.json';

/**
 * 校验 OpenCode Platform 选项并拒绝任意 workspace 配置透传。
 *
 * @param options 用户声明的 Platform 选项。
 */
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
    /** workspace 首期只控制是否输出官方 Schema。 */
    for (const field of Object.keys(options.workspace)) {
      if (field !== 'schema')
        throw new TypeError(`Unknown OpenCode workspace option "${field}".`);
    }
    if (options.workspace.schema !== undefined && typeof options.workspace.schema !== 'boolean')
      throw new TypeError('OpenCode workspace.schema must be a boolean.');
  }
}

/**
 * 报告统一 Plugin 元数据在 workspace 交付中的省略结果。
 *
 * @param context Platform prepare 阶段的元数据报告出口。
 */
function reportMetadata(context: PlatformPrepareContext): void {
  /** OpenCode workspace 没有静态 Plugin Manifest，因此不会复制统一元数据。 */
  const fields = ['name', 'version', 'description', 'displayName', 'author', 'homepage', 'repository', 'license', 'keywords'] as const;
  /** field 表示当前实际存在或必填的统一元数据。 */
  for (const field of fields) {
    if (field === 'name' || field === 'version' || field === 'description' || context.project.metadata[field] !== undefined) {
      context.reportMetadata({
        field,
        disposition: 'omitted',
        reason: 'OpenCode delivery is a workspace, not a static Plugin Manifest.',
      });
    }
  }
}

/**
 * 创建按需序列化的 OpenCode workspace 配置 Document。
 *
 * @param context Platform prepare 生命周期上下文。
 * @returns 只向 MCP Extension 开放 mcp 根字段的受控 Document。
 */
export function createWorkspaceDocument(context: PlatformPrepareContext): DraftDocument {
  reportMetadata(context);
  /** 工厂选项中已由边界校验的 workspace 配置。 */
  const options = context.options.workspace as OpenCodeWorkspaceOptions | undefined;
  /** 默认空对象在没有 Extension patch 时不会物化为 opencode.json。 */
  const value: JsonObject = options?.schema === true ? { $schema: OPENCODE_SCHEMA_URL } : {};
  return {
    id: WORKSPACE_CONFIG_ID,
    path: WORKSPACE_CONFIG_PATH,
    format: 'json',
    owner: PLATFORM_OWNER,
    value,
    emission: 'omit-if-empty',
    extensionPoints: [['mcp']],
  };
}

/**
 * 按需序列化完成 Adapter patch 的 OpenCode workspace 配置。
 *
 * @param documents 当前 Platform Draft 的完整 Document 列表。
 * @returns 空配置不产生文件，其余情况返回固定 opencode.json Artifact。
 */
export function serializeDocuments(documents: readonly DraftDocument[]): ArtifactInput[] {
  /** 按逻辑 ID 查找唯一 workspace 配置。 */
  const config = documents.find(document => document.id === WORKSPACE_CONFIG_ID);
  if (!config || config.path !== WORKSPACE_CONFIG_PATH || config.format !== 'json')
    throw new Error('OpenCode Platform Draft is missing its canonical workspace config Document.');
  if (documents.length !== 1)
    throw new Error('OpenCode Platform received an unknown Document.');
  /** 空对象代表没有平台或 Extension 配置，不覆盖消费 workspace 的通用配置。 */
  if (Object.keys(config.value as JsonObject).length === 0)
    return [];
  return [bytesArtifact(WORKSPACE_CONFIG_PATH, stableJson(config.value))];
}
