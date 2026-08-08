import {
  bytesArtifact,
  stableJson,
  type ArtifactInput,
  type DraftDocument,
  type JsonObject,
  type PlatformPrepareContext,
} from '@tokenroll/acplugin';

/** Antigravity Plugin 清单的稳定逻辑 Document ID。 */
export const PLUGIN_MANIFEST_ID = 'plugin-manifest';

/** Antigravity Plugin 清单相对于安装根的固定路径。 */
export const PLUGIN_MANIFEST_PATH = 'plugin.json';

/** Antigravity Platform 写入 Artifact 时使用的固定 owner。 */
const PLATFORM_OWNER = 'platform:antigravity' as const;

/** 创建 Antigravity Platform 时可声明的公开选项。 */
export interface AntigravityPlatformOptions {
  /** 覆盖当前 Platform 的兼容性严格度。 */
  readonly strict?: boolean;
}

/**
 * 校验 Antigravity Platform 只接受已由官方文档确认的最小选项。
 *
 * @param options 用户声明的 Platform 选项。
 */
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

/**
 * 报告统一元数据在最小 Antigravity Manifest 中的最终去向。
 *
 * @param context Platform prepare 阶段的元数据报告出口。
 */
function reportMetadata(context: PlatformPrepareContext): void {
  context.reportMetadata({
    field: 'name',
    disposition: 'emitted',
    output: `${PLUGIN_MANIFEST_PATH}.name`,
    reason: 'Antigravity plugin.json publicly documents the name field.',
  });
  /** 除 name 外的统一字段均没有经过公开 Manifest 契约确认。 */
  const fields = ['version', 'description', 'displayName', 'author', 'homepage', 'repository', 'license', 'keywords'] as const;
  /** field 表示当前可能被作者声明但必须省略的统一元数据。 */
  for (const field of fields) {
    if (field === 'version' || field === 'description' || context.project.metadata[field] !== undefined) {
      context.reportMetadata({
        field,
        disposition: 'omitted',
        reason: `Antigravity's public Plugin Manifest contract has not confirmed ${field}.`,
      });
      context.reportDiagnostic({
        code: 'ANTIGRAVITY_METADATA_OMITTED',
        severity: 'warning',
        message: `Antigravity output omits metadata field "${field}" because it is not publicly documented.`,
        fieldPath: [field],
      });
    }
  }
}

/**
 * 创建只包含官方文档确认 name 的 Antigravity Plugin Manifest。
 *
 * @param context Platform prepare 生命周期上下文。
 * @returns 不向 Extension 暴露猜测字段的单一 Document。
 */
export function createManifestDocument(context: PlatformPrepareContext): DraftDocument {
  reportMetadata(context);
  return {
    id: PLUGIN_MANIFEST_ID,
    path: PLUGIN_MANIFEST_PATH,
    format: 'json',
    owner: PLATFORM_OWNER,
    value: { name: context.project.metadata.name } as JsonObject,
    extensionPoints: [],
  };
}

/**
 * 将 Antigravity Plugin Document 序列化为 Artifact。
 *
 * @param documents 当前 Platform Draft 中由 Core 冻结的完整文档列表。
 * @returns 固定根 plugin.json Artifact。
 */
export function serializeDocuments(documents: readonly DraftDocument[]): ArtifactInput[] {
  /** 按逻辑 ID 查找唯一 Plugin Manifest。 */
  const manifest = documents.find(document => document.id === PLUGIN_MANIFEST_ID);
  if (!manifest || manifest.path !== PLUGIN_MANIFEST_PATH || manifest.format !== 'json')
    throw new Error('Antigravity Platform Draft is missing its canonical Plugin Manifest Document.');
  if (documents.length !== 1)
    throw new Error('Antigravity Platform received an unknown Document.');
  return [bytesArtifact(PLUGIN_MANIFEST_PATH, stableJson(manifest.value))];
}
