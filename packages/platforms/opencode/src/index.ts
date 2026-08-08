import { definePlatform, type AcpluginPlatform, type JsonObject } from '@acplugin/core';
import { generateComponentArtifacts, validateOpenCodeComponentFields } from './components.js';
import { createWorkspaceDocument, serializeDocuments, validatePlatformOptions } from './config-document.js';
import type { OpenCodePlatformOptions } from './types.js';
import { validateOpenCodeBundle } from './validator.js';

export type { OpenCodePlatformOptions, OpenCodeWorkspaceOptions } from './types.js';

/** OpenCode Platform 的稳定开放 ID。 */
export const PLATFORM_ID = 'opencode' as const;
/** OpenCode Platform 实现的 Core API 版本。 */
export const PLATFORM_API_VERSION = '1' as const;

/**
 * 创建独立且可由 Core 品牌校验的 OpenCode Platform。
 *
 * @param options 严格度覆盖和 workspace 配置选项。
 * @returns OpenCode workspace 交付实现。
 */
export function openCode(options: OpenCodePlatformOptions = {}): AcpluginPlatform {
  validatePlatformOptions(options);
  /** strict 属于 Core 策略，其余字段作为 Platform 生命周期专属配置保存。 */
  const { strict, ...platformOptions } = options;
  return definePlatform({
    id: PLATFORM_ID,
    apiVersion: PLATFORM_API_VERSION,
    deliveryType: 'workspace',
    ...(strict === undefined ? {} : { strict }),
    options: platformOptions as unknown as JsonObject,
    validateComponentFields: validateOpenCodeComponentFields,
    /** prepare 创建可由 MCP Adapter add-only patch 的 workspace Document。 */
    prepare: context => ({ documents: [createWorkspaceDocument(context)], artifacts: [] }),
    /** generateBundle 生成资源，并仅在有配置时物化 opencode.json。 */
    generateBundle: context => ({
      id: 'workspace',
      role: 'primary',
      type: 'workspace',
      artifacts: [
        ...context.artifacts,
        ...generateComponentArtifacts(context),
        ...serializeDocuments(context.documents),
      ],
    }),
    /** 最终候选不得伪造 Plugin Manifest 或覆盖通用 package.json。 */
    validateBundle: validateOpenCodeBundle,
  });
}
