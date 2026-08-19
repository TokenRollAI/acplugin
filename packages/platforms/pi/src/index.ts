import {
  definePlatform,
  type AcpluginPlatform,
  type JsonObject,
} from '@tokenroll/acplugin/sdk';
import {
  createPiComponents,
  hasGeneratedSkills,
  validateGeneratedSkillIds,
  validatePiComponent,
} from './components.js';
import { createPackageDocument, validatePlatformOptions } from './manifest.js';
import type { PiPlatformOptions } from './types.js';
import { validatePiPackage } from './validator.js';

export type { PiPackageOptions, PiPlatformOptions } from './types.js';

/** Pi Platform 的稳定开放 ID。 */
export const PLATFORM_ID = 'pi' as const;

/** Pi Platform 实现的 Core API 版本。 */
export const PLATFORM_API_VERSION = '1' as const;

/** 创建只通过 Package API 交付 npm Package 的 Pi Platform。 */
export function pi(options: PiPlatformOptions = {}): AcpluginPlatform {
  validatePlatformOptions(options);
  /** strict 由 Core 解释，其余选项复制、深冻后进入 Platform Session。 */
  const { strict, ...platformOptions } = options;
  return definePlatform({
    id: PLATFORM_ID,
    apiVersion: PLATFORM_API_VERSION,
    deliveryType: 'package',
    ...(strict === undefined ? {} : { strict }),
    options: platformOptions as unknown as JsonObject,
    /** Pi 不声明 Node Runtime 能力，Core 会对每个 Runtime 报告 unsupported。 */
    createSession({ options: sessionOptions }) {
      return {
        validateComponent: validatePiComponent,
        /** base Package 包含 Prompt/Skill Assets 和唯一 npm Manifest Document。 */
        async createPackage({ project, assets, diagnostics }) {
          /** idsValid 防止 native/fallback Skill namespace 有歧义时签发 Assets。 */
          const idsValid = validateGeneratedSkillIds(project, diagnostics);
          /** components 只在 namespace 完整时创建。 */
          const components = idsValid
            ? await createPiComponents(project, assets)
            : { assets: Object.freeze([]), compatibility: Object.freeze([]) };
          /** manifest 根据真实 canonical 资源声明 discovery roots。 */
          const manifest = createPackageDocument({
            metadata: project.metadata,
            options: sessionOptions,
            hasSkills: hasGeneratedSkills(project),
            hasPrompts: project.commands.length > 0,
          });
          return {
            documents: [manifest.document],
            assets: components.assets,
            compatibility: components.compatibility,
            metadata: manifest.metadata,
          };
        },
        /** Core 自动继承 base Assets 和无序 Hooks Contribution。 */
        finalizePackage: () => ({ id: 'package', type: 'package' }),
        validatePackage: validatePiPackage,
      };
    },
  });
}

export default pi;
