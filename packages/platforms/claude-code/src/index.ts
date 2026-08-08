import {
  definePlatform,
  type AcpluginPlatform,
  type JsonObject,
} from '@acplugin/core';
import { generateComponentArtifacts, validateClaudeComponentFields } from './components.js';
import {
  createManifestDocument,
  marketplaceArtifacts,
  MARKETPLACE_MANIFEST_PATH,
  serializeDocuments,
  validatePlatformOptions,
} from './manifest.js';
import type { ClaudeCodeMarketplaceOptions, ClaudeCodePlatformOptions } from './types.js';
import { validateClaudeBundle } from './validator.js';

export type {
  ClaudeCodeMarketplaceOptions,
  ClaudeCodeMarketplaceOwner,
  ClaudeCodePlatformOptions,
} from './types.js';

/** Claude Code Platform 的稳定开放 ID。 */
export const PLATFORM_ID = 'claude-code' as const;
/** Claude Code Platform 实现的 Core API 版本。 */
export const PLATFORM_API_VERSION = '1' as const;

/**
 * 创建独立且可由 Core 品牌校验的 Claude Code Platform。
 *
 * @param options 严格度覆盖和 Claude Code Marketplace 选项。
 * @returns Claude Code Plugin 交付实现。
 */
export function claudeCode(options: ClaudeCodePlatformOptions = {}): AcpluginPlatform {
  validatePlatformOptions(options);
  /** strict 属于 Core 策略，其余字段作为 Platform 生命周期专属配置保存。 */
  const { strict, ...platformOptions } = options;
  return definePlatform({
    id: PLATFORM_ID,
    apiVersion: PLATFORM_API_VERSION,
    deliveryType: 'plugin',
    ...(strict === undefined ? {} : { strict }),
    options: platformOptions as unknown as JsonObject,
    validateComponentFields: validateClaudeComponentFields,
    /** prepare 创建 Platform 自有 Manifest，扩展点随后由 Core 接管。 */
    prepare: context => ({ documents: [createManifestDocument(context)], artifacts: [] }),
    /** generateBundle 只读取完成 Adapter 合并后的不可变 Draft。 */
    generateBundle: (context) => {
      /** Platform 转换后新增的 Commands、Skills 与 Agents。 */
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
    validateBundle: validateClaudeBundle,
    /** Marketplace 可选分发始终复用已经验证的完整主 Plugin。 */
    generateDistributions: async (context, primaryUnits) => {
      /** 工厂未声明 marketplace 时不生成空壳 Distribution。 */
      const marketplace = context.options.marketplace as ClaudeCodeMarketplaceOptions | undefined;
      if (marketplace === undefined)
        return [];
      if (primaryUnits.length === 0)
        throw new Error('Claude Code Marketplace requires at least one validated primary Plugin.');
      /** 任一主 Plugin 都不能预先占用 Distribution 根清单的保留语义。 */
      if (primaryUnits.some(primary => primary.artifacts.some(artifact => artifact.path === MARKETPLACE_MANIFEST_PATH))) {
        context.reportDiagnostic({
          code: 'CLAUDE_MARKETPLACE_PATH_CONFLICT',
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
