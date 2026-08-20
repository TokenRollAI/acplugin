import {
  definePlatform,
  type AcpluginPlatform,
  type JsonObject,
} from '@tokenroll/acplugin/sdk';
import { createCursorComponents, validateCursorComponent } from './package/components.js';
import { createPluginDocument, validatePlatformOptions } from './package/manifest.js';
import type { CursorPlatformOptions } from './types.js';
import { validateCursorPackage } from './package/validator.js';

export type { CursorPlatformOptions } from './types.js';

/** Cursor Platform 的稳定开放 ID。 */
export const PLATFORM_ID = 'cursor' as const;

/** Cursor Platform 实现的 Core API 版本。 */
export const PLATFORM_API_VERSION = '1' as const;

/** 创建只通过 Package API 交付 Cursor Plugin 的 Platform。 */
export function cursor(options: CursorPlatformOptions = {}): AcpluginPlatform {
  validatePlatformOptions(options);
  /** strict 由 Core 解释，其余选项复制、深冻后进入 Platform Session。 */
  const { strict, ...platformOptions } = options;
  return definePlatform({
    id: PLATFORM_ID,
    apiVersion: PLATFORM_API_VERSION,
    deliveryType: 'plugin',
    ...(strict === undefined ? {} : { strict }),
    options: platformOptions as unknown as JsonObject,
    /** Cursor 不声明 Node Runtime 能力，Core 将对存在的 Runtime 显式报告 unsupported。 */
    createSession({ options: sessionOptions }) {
      return {
        validateComponent: validateCursorComponent,
        /** base Package 包含原生 Components 和唯一结构化 Manifest。 */
        async createPackage({ project, assets }) {
          /** components 全部通过当前 Platform owner 的 Asset Service 签发。 */
          const components = await createCursorComponents(project, assets);
          /** manifest 由 Core codec 负责序列化，Extension 只能填写声明点。 */
          const manifest = createPluginDocument({ project, options: sessionOptions });
          return {
            documents: [manifest.document],
            assets: components.assets,
            compatibility: components.compatibility,
            metadata: manifest.metadata,
          };
        },
        /** Core 自动继承 base、Public 和 add-only Contributions。 */
        finalizePackage: () => ({ id: 'plugin', type: 'plugin' }),
        validatePackage: validateCursorPackage,
      };
    },
  });
}

export default cursor;
