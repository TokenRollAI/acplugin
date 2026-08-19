import {
  definePlatform,
  type AcpluginPlatform,
  type JsonObject,
} from '@tokenroll/acplugin/sdk';
import { createClaudeComponents, validateClaudeComponent } from './components.js';
import {
  createMarketplaceAssets,
  createPluginDocument,
  validatePlatformOptions,
} from './manifest.js';
import type { ClaudeCodeMarketplaceOptions, ClaudeCodePlatformOptions } from './types.js';
import { validateClaudePackage } from './validator.js';

export type {
  ClaudeCodeMarketplaceOptions,
  ClaudeCodeMarketplaceOwner,
  ClaudeCodePlatformOptions,
} from './types.js';

/** Claude Code Platform 的稳定开放 ID。 */
export const PLATFORM_ID = 'claude-code' as const;

/** Claude Code Platform 实现的 Core API 版本。 */
export const PLATFORM_API_VERSION = '1' as const;

/** 创建只通过 Package API 交付 Claude Code Plugin 的 Platform。 */
export function claudeCode(options: ClaudeCodePlatformOptions = {}): AcpluginPlatform {
  validatePlatformOptions(options);
  /** strict 由 Core 解释，其余选项进入复制、深冻的 Platform session 数据。 */
  const { strict, ...platformOptions } = options;
  return definePlatform({
    id: PLATFORM_ID,
    apiVersion: PLATFORM_API_VERSION,
    deliveryType: 'plugin',
    capabilities: { nodeRuntime: { target: 'node20', format: 'esm', root: 'plugin' } },
    ...(strict === undefined ? {} : { strict }),
    options: platformOptions as unknown as JsonObject,
    /** 每次 BuildSession 独立捕获 Core 已复制的只读 Platform options。 */
    createSession({ options: sessionOptions }) {
      return {
        validateComponent: validateClaudeComponent,
        /** base Package 同时声明结构化 Document、Component Assets 和完整报告输入。 */
        async createPackage({ project, assets }) {
          /** components 是 canonical Resource 到 Claude 原生文件的纯转换结果。 */
          const components = await createClaudeComponents(project, assets);
          /** manifest 由 Core codec 负责序列化，Extension 只能填写两个声明点。 */
          const manifest = createPluginDocument({
            metadata: project.metadata,
            options: sessionOptions,
            components: {
              commands: project.commands.length,
              skills: project.skills.length,
              agents: project.agents.length,
            },
          });
          return {
            documents: [manifest.document],
            assets: components.assets,
            compatibility: components.compatibility,
            metadata: manifest.metadata,
          };
        },
        /** 主 Package 身份固定，全部 base/contribution 内容由 Core 自动继承。 */
        finalizePackage: () => ({ id: 'plugin', type: 'plugin' }),
        validatePackage: validateClaudePackage,
        /** 可选 Marketplace 只能从已验证 primary 和当前回调新签发 Asset 派生。 */
        async createDistributions(context) {
          /** marketplace 必须来自 session 的防御性副本，不能闭包读取作者原对象。 */
          const marketplace = sessionOptions.marketplace as ClaudeCodeMarketplaceOptions | undefined;
          if (marketplace === undefined)
            return Object.freeze([]);
          return Object.freeze([{
            id: 'marketplace',
            type: 'marketplace' as const,
            assets: await createMarketplaceAssets(context, marketplace),
          }]);
        },
      };
    },
  });
}

export default claudeCode;
