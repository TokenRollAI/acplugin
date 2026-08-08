import {
  definePlatform,
  type AcpluginPlatform,
  type JsonObject,
} from '@tokenroll/acplugin';
import {
  generateComponentArtifacts,
  validateCodexComponentFields,
  validateGeneratedSkillIds,
} from './components.js';
import {
  createManifestDocument,
  marketplaceArtifacts,
  MARKETPLACE_MANIFEST_PATH,
  serializeDocuments,
  validatePlatformOptions,
} from './manifest.js';
import type { CodexMarketplaceOptions, CodexPlatformOptions } from './types.js';
import { validateCodexBundle } from './validator.js';

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

/**
 * 创建独立且可由 Core 品牌校验的 Codex Platform。
 *
 * @param options 严格度覆盖、安装界面与 Marketplace 选项。
 * @returns Codex Plugin 交付实现。
 */
export function codex(options: CodexPlatformOptions = {}): AcpluginPlatform {
  validatePlatformOptions(options);
  /** strict 属于 Core 策略，其余字段作为 Platform 生命周期专属配置保存。 */
  const { strict, ...platformOptions } = options;
  return definePlatform({
    id: PLATFORM_ID,
    apiVersion: PLATFORM_API_VERSION,
    deliveryType: 'plugin',
    ...(strict === undefined ? {} : { strict }),
    options: platformOptions as unknown as JsonObject,
    validateComponentFields: validateCodexComponentFields,
    /** prepare 固定 Manifest、最终 Skill 命名空间和 Extension 空位。 */
    prepare: (context) => {
      validateGeneratedSkillIds(context);
      return { documents: [createManifestDocument(context)], artifacts: [] };
    },
    /** generateBundle 在 Adapter 合并完成后生成 Skills 并序列化 Manifest。 */
    generateBundle: (context) => {
      /** 原生 Skill 与 Command/Agent fallback 产生的 Component Artifact。 */
      const componentArtifacts = generateComponentArtifacts(context);
      return {
        id: 'plugin',
        role: 'primary',
        type: 'plugin',
        artifacts: [
          ...context.artifacts,
          ...componentArtifacts,
          ...serializeDocuments(context.documents),
        ],
      };
    },
    validateBundle: validateCodexBundle,
    /** Marketplace Distribution 始终复用已经验证的完整主 Plugin。 */
    generateDistributions: async (context, primaryUnits) => {
      /** 工厂未声明 marketplace 时不生成空壳 Distribution。 */
      const marketplace = context.options.marketplace as CodexMarketplaceOptions | undefined;
      if (marketplace === undefined)
        return [];
      if (primaryUnits.length === 0)
        throw new Error('Codex Marketplace requires at least one validated primary Plugin.');
      /** 任一主 Plugin 都不能预先占用 Distribution 根清单的保留语义。 */
      if (primaryUnits.some(primary => primary.artifacts.some(artifact => artifact.path === MARKETPLACE_MANIFEST_PATH))) {
        context.reportDiagnostic({
          code: 'CODEX_MARKETPLACE_PATH_CONFLICT',
          severity: 'error',
          message: 'The primary Plugin already contains the reserved Marketplace manifest path.',
        });
        return [];
      }
      /** 单项保持根布局，多项由 Platform 确定性放入各自 Plugin 子目录。 */
      const artifacts = await marketplaceArtifacts(context, marketplace, primaryUnits);
      return [{ id: 'marketplace', role: 'distribution', type: 'marketplace', artifacts }];
    },
  });
}

export default codex;
