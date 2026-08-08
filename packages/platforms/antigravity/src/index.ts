import { definePlatform, type AcpluginPlatform } from '@tokenroll/acplugin';
import {
  generateComponentArtifacts,
  validateAntigravityComponentFields,
  validateGeneratedSkillIds,
} from './components.js';
import {
  createManifestDocument,
  serializeDocuments,
  validatePlatformOptions,
  type AntigravityPlatformOptions,
} from './manifest.js';
import { validateAntigravityBundle } from './validator.js';

export type { AntigravityPlatformOptions } from './manifest.js';

/** Antigravity Platform 的稳定开放 ID。 */
export const PLATFORM_ID = 'antigravity' as const;
/** Antigravity Platform 实现的 Core API 版本。 */
export const PLATFORM_API_VERSION = '1' as const;

/**
 * 创建独立且可由 Core 品牌校验的 Antigravity Platform。
 *
 * @param options 当前 Platform 的严格度覆盖。
 * @returns Antigravity Plugin 交付实现。
 */
export function antigravity(options: AntigravityPlatformOptions = {}): AcpluginPlatform {
  validatePlatformOptions(options);
  return definePlatform({
    id: PLATFORM_ID,
    apiVersion: PLATFORM_API_VERSION,
    deliveryType: 'plugin',
    ...(options.strict === undefined ? {} : { strict: options.strict }),
    options: {},
    validateComponentFields: validateAntigravityComponentFields,
    /** prepare 先验证 fallback Skill 命名空间，再创建最小 Manifest。 */
    prepare: (context) => {
      validateGeneratedSkillIds(context);
      return { documents: [createManifestDocument(context)], artifacts: [] };
    },
    /** generateBundle 只生成官方文档确认的根结构。 */
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
    /** 最终候选使用内部严格 Schema 固定最小字段原则。 */
    validateBundle: validateAntigravityBundle,
  });
}

export default antigravity;
