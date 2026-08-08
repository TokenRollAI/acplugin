import {
  bytesArtifact,
  stableJson,
  type ArtifactInput,
  type DraftDocument,
  type JsonObject,
  type PlatformPrepareContext,
} from '@tokenroll/acplugin';
import { hasGeneratedSkills } from './components.js';
import type { PiPackageOptions, PiPlatformOptions } from './types.js';

/** Pi npm package 清单的稳定逻辑 Document ID。 */
export const PACKAGE_MANIFEST_ID = 'package-manifest';

/** Pi npm package 清单相对于交付根的固定路径。 */
export const PACKAGE_MANIFEST_PATH = 'package.json';

/** Pi Platform 写入 Document 时使用的固定 owner。 */
const PLATFORM_OWNER = 'platform:pi' as const;

/**
 * 判断值是否为非空字符串。
 *
 * @param value Platform 工厂收到的未知候选。
 * @returns 可安全进入 package.json 时返回 true。
 */
function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * 校验 Pi Platform 选项并拒绝任意 npm 字段透传。
 *
 * @param options 用户声明的 Platform 选项。
 */
export function validatePlatformOptions(options: PiPlatformOptions): void {
  /** Platform 顶层只允许 strict 和受控 package 子对象。 */
  const allowed = new Set(['strict', 'package']);
  for (const field of Object.keys(options)) {
    if (!allowed.has(field))
      throw new TypeError(`Unknown Pi Platform option "${field}".`);
  }
  if (options.strict !== undefined && typeof options.strict !== 'boolean')
    throw new TypeError('Pi strict must be a boolean.');
  if (options.package !== undefined) {
    if (options.package === null || typeof options.package !== 'object' || Array.isArray(options.package))
      throw new TypeError('Pi package must be a plain object.');
    /** Pi package 首期只开放官方 Gallery 的 image/video。 */
    for (const field of Object.keys(options.package)) {
      if (field !== 'image' && field !== 'video')
        throw new TypeError(`Unknown Pi package option "${field}".`);
    }
    /** field 表示当前 Gallery 可选 URL 或路径字段。 */
    for (const field of ['image', 'video'] as const) {
      if (options.package[field] !== undefined && !isNonEmptyString(options.package[field]))
        throw new TypeError(`Pi package.${field} must be a non-empty string.`);
    }
  }
}

/**
 * 报告统一元数据在 Pi npm package 中的最终去向。
 *
 * @param context Platform prepare 阶段的元数据报告出口。
 */
function reportMetadata(context: PlatformPrepareContext): void {
  /** npm 原生支持且 acplugin 会稳定写入的字段。 */
  const emitted = ['name', 'version', 'description', 'author', 'homepage', 'repository', 'license', 'keywords'] as const;
  /** field 表示当前必填或实际声明的 npm 元数据。 */
  for (const field of emitted) {
    if (field === 'name' || field === 'version' || field === 'description' || context.project.metadata[field] !== undefined) {
      context.reportMetadata({
        field,
        disposition: 'emitted',
        output: `${PACKAGE_MANIFEST_PATH}.${field}`,
        reason: `npm package.json supports ${field}.`,
      });
    }
  }
  if (context.project.metadata.displayName !== undefined) {
    context.reportMetadata({
      field: 'displayName',
      disposition: 'omitted',
      reason: 'npm package.json and the Pi package contract have no displayName field.',
    });
    context.reportDiagnostic({
      code: 'PI_METADATA_DISPLAY_NAME_OMITTED',
      severity: 'warning',
      message: 'Pi package output omits displayName because the package contract has no matching field.',
      fieldPath: ['displayName'],
    });
  }
}

/**
 * 创建可由 Hooks Adapter add-only patch 的 Pi npm package manifest。
 *
 * @param context Platform prepare 生命周期上下文。
 * @returns 固定 package.json Document。
 */
export function createPackageDocument(context: PlatformPrepareContext): DraftDocument {
  reportMetadata(context);
  /** 统一 Plugin 元数据。 */
  const metadata = context.project.metadata;
  /** 工厂边界已经验证的 Pi Gallery 选项。 */
  const packageOptions = context.options.package as PiPackageOptions | undefined;
  /** `pi-package` 必须存在且与统一关键词稳定去重。 */
  const keywords = [...new Set([...(metadata.keywords ?? []), 'pi-package'])];
  /** Pi package discovery 使用的静态资源清单。 */
  const pi: Record<string, unknown> = {
    ...(hasGeneratedSkills(context.project) ? { skills: ['./skills'] } : {}),
    ...(context.project.commands.length > 0 ? { prompts: ['./prompts'] } : {}),
    ...(packageOptions?.image === undefined ? {} : { image: packageOptions.image }),
    ...(packageOptions?.video === undefined ? {} : { video: packageOptions.video }),
  };
  /** npm 支持的统一元数据和 Pi discovery 配置。 */
  const value: JsonObject = {
    name: metadata.name,
    version: metadata.version,
    description: metadata.description,
    type: 'module',
    keywords,
    ...(metadata.author === undefined ? {} : { author: metadata.author }),
    ...(metadata.homepage === undefined ? {} : { homepage: metadata.homepage }),
    ...(metadata.repository === undefined ? {} : { repository: metadata.repository }),
    ...(metadata.license === undefined ? {} : { license: metadata.license }),
    pi,
  } as unknown as JsonObject;
  return {
    id: PACKAGE_MANIFEST_ID,
    path: PACKAGE_MANIFEST_PATH,
    format: 'json',
    owner: PLATFORM_OWNER,
    value,
    extensionPoints: [['pi', 'extensions']],
  };
}

/**
 * 序列化完成 Adapter patch 的 Pi package manifest。
 *
 * @param documents 当前 Platform Draft 的完整 Document 列表。
 * @returns 固定 package.json Artifact。
 */
export function serializeDocuments(documents: readonly DraftDocument[]): ArtifactInput[] {
  /** 按逻辑 ID 查找唯一 npm package manifest。 */
  const manifest = documents.find(document => document.id === PACKAGE_MANIFEST_ID);
  if (!manifest || manifest.path !== PACKAGE_MANIFEST_PATH || manifest.format !== 'json')
    throw new Error('Pi Platform Draft is missing its canonical package manifest Document.');
  if (documents.length !== 1)
    throw new Error('Pi Platform received an unknown Document.');
  return [bytesArtifact(PACKAGE_MANIFEST_PATH, stableJson(manifest.value))];
}
