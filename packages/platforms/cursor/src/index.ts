import { definePlatform, type AcpluginPlatform, type JsonObject } from '@tokenroll/acplugin';
import { generateComponentArtifacts, validateCursorComponentFields } from './components.js';
import { createManifestDocument, serializeDocuments, validatePlatformOptions } from './manifest.js';
import type { CursorPlatformOptions } from './types.js';
import { validateCursorBundle } from './validator.js';

export type { CursorPlatformOptions } from './types.js';

/** Cursor Platform 的稳定开放 ID。 */
export const PLATFORM_ID = 'cursor' as const;
/** Cursor Platform 实现的 Core API 版本。 */
export const PLATFORM_API_VERSION = '1' as const;

/**
 * 创建独立且可由 Core 品牌校验的 Cursor Platform。
 *
 * @param options 当前 Platform 的严格度覆盖。
 * @returns Cursor Plugin 交付实现。
 */
export function cursor(options: CursorPlatformOptions = {}): AcpluginPlatform {
  validatePlatformOptions(options);
  /** strict 属于 Core 策略，其余字段作为 Platform 生命周期专属配置保存。 */
  const { strict, ...platformOptions } = options;
  return definePlatform({
    id: PLATFORM_ID,
    apiVersion: PLATFORM_API_VERSION,
    deliveryType: 'plugin',
    ...(strict === undefined ? {} : { strict }),
    options: platformOptions as unknown as JsonObject,
    validateComponentFields: validateCursorComponentFields,
    /** prepare 创建 Platform 自有 Manifest，扩展点随后由 Core 接管。 */
    prepare: context => ({ documents: [createManifestDocument(context)], artifacts: [] }),
    /** generateBundle 转换 Component 并序列化完成 Adapter 合并的 Document。 */
    generateBundle: context => ({
      id: 'plugin',
      role: 'primary',
      type: 'plugin',
      artifacts: [
        ...context.artifacts,
        ...generateComponentArtifacts(context),
        ...serializeDocuments(context.documents),
      ],
    }),
    /** 最终候选必须满足固定官方 Schema 子集和全部引用边界。 */
    validateBundle: validateCursorBundle,
  });
}

export default cursor;
