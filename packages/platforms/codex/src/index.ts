import {
  definePlatform,
  type AcpluginPlatform,
  type JsonObject,
} from '@tokenroll/acplugin/sdk';
import {
  createCodexComponents,
  validateCodexComponent,
  validateGeneratedSkillIds,
} from './package/components.js';
import {
  createMarketplaceAssets,
  createPluginDocument,
  validatePlatformOptions,
} from './package/manifest.js';
import type { CodexInterfaceOptions, CodexMarketplaceOptions, CodexPlatformOptions } from './types.js';
import { validateCodexPackage } from './package/validation/index.js';

export type {
  CodexCategory,
  CodexInterfaceOptions,
  CodexMarketplaceInstallation,
  CodexMarketplaceOptions,
  CodexMarketplacePolicyOptions,
  CodexPlatformOptions,
} from './types.js';

/** Codex Platform 的稳定开放 ID。 */
export const PLATFORM_ID = 'codex' as const;

/** Codex Platform 实现的 Core API 版本。 */
export const PLATFORM_API_VERSION = '1' as const;

/** 创建只通过 Package API 交付 Codex Plugin 的 Platform。 */
export function codex(options: CodexPlatformOptions = {}): AcpluginPlatform {
  validatePlatformOptions(options);
  /** strict 由 Core 解释，其余选项复制、深冻后提供给每个 Session。 */
  const { strict, ...platformOptions } = options;
  return definePlatform({
    id: PLATFORM_ID,
    apiVersion: PLATFORM_API_VERSION,
    deliveryType: 'plugin',
    capabilities: { nodeRuntime: { target: 'node20', format: 'esm', root: 'plugin' } },
    ...(strict === undefined ? {} : { strict }),
    options: platformOptions as unknown as JsonObject,
    /** 每轮构建只读取 Core 已复制的 sessionOptions。 */
    createSession({ options: sessionOptions }) {
      return {
        validateComponent: validateCodexComponent,
        /** base Package 在生成任何 Asset 前检查最终共享 Skill namespace。 */
        async createPackage({ project, assets, diagnostics }) {
          /** idsValid 防止 collision 诊断后继续签发有歧义的 bytes。 */
          const idsValid = validateGeneratedSkillIds(project, diagnostics);
          /** manifest 可独立报告空 Skill 项目错误。 */
          const manifest = createPluginDocument({ project, options: sessionOptions, diagnostics });
          /** components 只在最终命名空间无冲突时构建。 */
          const components = idsValid
            ? await createCodexComponents(project, assets)
            : { assets: Object.freeze([]), compatibility: Object.freeze([]) };
          return {
            documents: [manifest.document],
            assets: components.assets,
            compatibility: components.compatibility,
            metadata: manifest.metadata,
          };
        },
        /**
         * Codex 尚未拥有 Platform Component 的原生交付契约。
         *
         * 不能静默丢弃 opaque payload，也不能把它伪装成 `agent-*` Skill；两者都会
         * 让 Extension 对实际交付能力得到错误结论。等 Codex 有经过验证的本地表达
         * 时，由本包定义 payload union 和 finalization renderer。
         */
        finalizePackage: ({ package: mergedPackage, diagnostics }) => {
          if (mergedPackage.components.length > 0) {
            diagnostics.report({
              code: 'CODEX_COMPONENT_CONTRIBUTION_UNSUPPORTED',
              severity: 'error',
              message: 'Codex does not support Platform Component contributions.',
            });
          }
          return { id: 'plugin', type: 'plugin' };
        },
        validatePackage: validateCodexPackage,
        /** 可选 Marketplace 只继承已验证 primary 的真实 AssetRef。 */
        async createDistributions(context) {
          /** marketplace 和 interface 都来自同一个 session options snapshot。 */
          const marketplace = sessionOptions.marketplace as CodexMarketplaceOptions | undefined;
          if (marketplace === undefined)
            return Object.freeze([]);
          return Object.freeze([{
            id: 'marketplace',
            type: 'marketplace' as const,
            assets: await createMarketplaceAssets(
              context,
              marketplace,
              sessionOptions.interface as CodexInterfaceOptions | undefined,
            ),
          }]);
        },
      };
    },
  });
}

export default codex;
