import {
  definePlatform,
  type AcpluginPlatform,
} from '@tokenroll/acplugin/sdk';
import {
  createAntigravityComponents,
  validateAntigravityComponent,
  validateGeneratedSkillIds,
} from './package/components.js';
import {
  createPluginDocument,
  validatePlatformOptions,
  type AntigravityPlatformOptions,
} from './package/manifest.js';
import { validateAntigravityPackage } from './package/validator.js';

export type { AntigravityPlatformOptions } from './package/manifest.js';

/** Antigravity Platform 的稳定开放 ID。 */
export const PLATFORM_ID = 'antigravity' as const;

/** Antigravity Platform 实现的 Core API 版本。 */
export const PLATFORM_API_VERSION = '1' as const;

/** 创建只通过 Package API 交付 Antigravity Plugin 的 Platform。 */
export function antigravity(options: AntigravityPlatformOptions = {}): AcpluginPlatform {
  validatePlatformOptions(options);
  return definePlatform({
    id: PLATFORM_ID,
    apiVersion: PLATFORM_API_VERSION,
    deliveryType: 'plugin',
    ...(options.strict === undefined ? {} : { strict: options.strict }),
    options: {},
    /** Antigravity 不声明 Node Runtime 能力，Core 对 Runtime 显式报告 unsupported。 */
    createSession: () => ({
      validateComponent: validateAntigravityComponent,
      /** 在 Asset 创建前完成最终 Skill namespace 校验。 */
      async createPackage({ project, assets, diagnostics }) {
        /** idsValid 防止 collision 诊断后继续签发有歧义的 Assets。 */
        const idsValid = validateGeneratedSkillIds(project, diagnostics);
        /** components 只在最终命名空间无冲突时创建。 */
        const components = idsValid
          ? await createAntigravityComponents(project, assets)
          : { assets: Object.freeze([]), compatibility: Object.freeze([]) };
        /** manifest 始终使用 Core codec 生成最小官方 Document。 */
        const manifest = createPluginDocument(project.metadata);
        return {
          documents: [manifest.document],
          assets: components.assets,
          compatibility: components.compatibility,
          metadata: manifest.metadata,
        };
      },
      /**
       * Antigravity 没有可验证的私有 Component wire contract。
       *
       * Payload 必须在最终交付边界显式拒绝，避免无声丢弃或把 Agent 错误降级成
       * 生成 Skill；未来支持时仍应由本 Platform 自己引入 union 和 renderer。
       */
      finalizePackage: ({ package: mergedPackage, diagnostics }) => {
        if (mergedPackage.components.length > 0) {
          diagnostics.report({
            code: 'ANTIGRAVITY_COMPONENT_CONTRIBUTION_UNSUPPORTED',
            severity: 'error',
            message: 'Antigravity does not support Platform Component contributions.',
          });
        }
        return { id: 'plugin', type: 'plugin' };
      },
      validatePackage: validateAntigravityPackage,
    }),
  });
}

export default antigravity;
