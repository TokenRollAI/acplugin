import { definePlatform, type AcpluginPlatform, type JsonObject } from '@acplugin/core';
import {
  generateComponentArtifacts,
  validateGeneratedSkillIds,
  validatePiComponentFields,
} from './components.js';
import { createPackageDocument, serializeDocuments, validatePlatformOptions } from './manifest.js';
import type { PiPlatformOptions } from './types.js';
import { validatePiBundle } from './validator.js';

export type { PiPackageOptions, PiPlatformOptions } from './types.js';

/** Pi Platform 的稳定开放 ID。 */
export const PLATFORM_ID = 'pi' as const;
/** Pi Platform 实现的 Core API 版本。 */
export const PLATFORM_API_VERSION = '1' as const;

/**
 * 创建独立且可由 Core 品牌校验的 Pi Platform。
 *
 * @param options 严格度覆盖和 npm package 选项。
 * @returns Pi package 交付实现。
 */
export function pi(options: PiPlatformOptions = {}): AcpluginPlatform {
  validatePlatformOptions(options);
  /** strict 属于 Core 策略，其余字段作为 Platform 生命周期专属配置保存。 */
  const { strict, ...platformOptions } = options;
  return definePlatform({
    id: PLATFORM_ID,
    apiVersion: PLATFORM_API_VERSION,
    deliveryType: 'package',
    ...(strict === undefined ? {} : { strict }),
    options: platformOptions as unknown as JsonObject,
    validateComponentFields: validatePiComponentFields,
    /** prepare 先验证 fallback Skill ID，再创建可由 Hooks Adapter patch 的 package Document。 */
    prepare: (context) => {
      validateGeneratedSkillIds(context);
      return { documents: [createPackageDocument(context)], artifacts: [] };
    },
    /** generateBundle 生成 package 资源并序列化固定 package.json。 */
    generateBundle: context => ({
      id: 'package',
      role: 'primary',
      type: 'package',
      artifacts: [
        ...context.artifacts,
        ...generateComponentArtifacts(context),
        ...serializeDocuments(context.documents),
      ],
    }),
    /** 最终候选必须满足 npm/Pi discovery 边界且无 workspace 泄漏。 */
    validateBundle: validatePiBundle,
  });
}
