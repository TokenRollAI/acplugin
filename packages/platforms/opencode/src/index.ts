import {
  definePlatform,
  type AcpluginPlatform,
  type JsonObject,
} from '@tokenroll/acplugin/sdk';
import { createOpenCodeComponents, validateOpenCodeComponent } from './components.js';
import { createWorkspaceDocument, validatePlatformOptions } from './config-document.js';
import type { OpenCodePlatformOptions } from './types.js';
import { validateOpenCodePackage } from './validator.js';

export type { OpenCodePlatformOptions, OpenCodeWorkspaceOptions } from './types.js';

/** OpenCode Platform 的稳定开放 ID。 */
export const PLATFORM_ID = 'opencode' as const;

/** OpenCode Platform 实现的 Core API 版本。 */
export const PLATFORM_API_VERSION = '1' as const;

/** 创建只通过 Package API 交付 OpenCode workspace overlay 的 Platform。 */
export function openCode(options: OpenCodePlatformOptions = {}): AcpluginPlatform {
  validatePlatformOptions(options);
  /** strict 由 Core 解释，其余选项复制、深冻后进入 Platform Session。 */
  const { strict, ...platformOptions } = options;
  return definePlatform({
    id: PLATFORM_ID,
    apiVersion: PLATFORM_API_VERSION,
    deliveryType: 'workspace',
    ...(strict === undefined ? {} : { strict }),
    options: platformOptions as unknown as JsonObject,
    /** OpenCode workspace 不声明 Plugin-local Node Runtime 能力。 */
    createSession({ options: sessionOptions }) {
      return {
        validateComponent: validateOpenCodeComponent,
        /** base Package 包含 workspace Components 和可省略的结构化配置。 */
        async createPackage({ project, assets }) {
          /** components 全部通过 Platform owner 的 Asset Service 签发。 */
          const components = await createOpenCodeComponents(project, assets);
          /** workspace config 由 Core codec 处理并只开放 MCP 字段。 */
          const config = createWorkspaceDocument({ metadata: project.metadata, options: sessionOptions });
          return {
            documents: [config.document],
            assets: components.assets,
            compatibility: components.compatibility,
            metadata: config.metadata,
          };
        },
        /** 主单元身份明确是 workspace，不伪装 Plugin root。 */
        finalizePackage: () => ({ id: 'workspace', type: 'workspace' }),
        validatePackage: validateOpenCodePackage,
      };
    },
  });
}

export default openCode;
