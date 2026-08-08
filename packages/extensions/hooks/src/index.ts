import {
  defineExtension,
  type AcpluginExtension,
} from '@tokenroll/acplugin';
import { createHooksAdapters } from './adapters.js';
import { buildHooks, type BuiltHooks } from './bundler.js';
import { EXTENSION_NAME, HOOK_ID_PATTERN } from './constants.js';
import {
  discoverHooks,
  type DiscoveredHooks,
  validateHooks,
} from './discovery.js';

export { EXTENSION_NAME } from './constants.js';
export {
  CLAUDE_CODE_PLATFORM_EVENTS,
  defineHook,
  HOOK_EVENTS,
} from './types.js';
export type {
  ClaudeCodeHookOptions,
  ClaudeCodePlatformHookEvent,
  CodexHookOptions,
  HookAdvisoryResult,
  HookContextResult,
  HookDecisionResult,
  HookDefinition,
  HookDefinitionInput,
  HookEvent,
  HookEventDeclaration,
  HookFlowResult,
  HookInput,
  HookInputBase,
  HookInputByEvent,
  HookPlatformOptions,
  HookResult,
  HookResultByEvent,
  HookRuntimeContext,
  PlatformHookEvent,
  PortableHookOptions,
} from './types.js';

/** 创建 Hooks Extension 时可声明的作者资源筛选选项。 */
export interface HooksExtensionOptions {
  /** 只构建这些 `src/hooks/<id>`；省略时构建全部 Hook。 */
  readonly include?: readonly string[];
}

/** Hooks Extension 工厂当前接受的公开配置字段。 */
const HOOKS_OPTION_FIELDS = new Set(['include']);

/**
 * 拒绝宽类型变量传入的未知 Extension 工厂字段。
 *
 * @param options 配置作者提供的 Hooks Extension 选项。
 */
function validateOptions(options: HooksExtensionOptions): void {
  if (options === null || typeof options !== 'object' || Array.isArray(options))
    throw new TypeError('Hooks options must be a plain object.');
  for (const field of Object.keys(options)) {
    if (!HOOKS_OPTION_FIELDS.has(field))
      throw new TypeError(`Unknown Hooks option "${field}".`);
  }
}

/**
 * 校验并冻结可选 Hook ID 白名单。
 *
 * @param include 配置作者提供的可选 ID 数组。
 * @returns 省略时返回 undefined，否则返回去重后的只读集合。
 */
function normalizeInclude(include: HooksExtensionOptions['include']): ReadonlySet<string> | undefined {
  if (include === undefined)
    return undefined;
  if (!Array.isArray(include))
    throw new TypeError('Hooks include must be an array of lowercase kebab-case IDs.');
  /** 去重后提供给 discover 阶段的 Hook ID。 */
  const result = new Set<string>();
  /** id 表示当前显式选择的 Hook ID。 */
  for (const id of include) {
    if (typeof id !== 'string' || !HOOK_ID_PATTERN.test(id))
      throw new TypeError('Hooks include must contain only lowercase kebab-case IDs.');
    if (result.has(id))
      throw new TypeError(`Hooks include contains duplicate ID "${id}".`);
    result.add(id);
  }
  return result;
}

/**
 * 创建端到端拥有 Hook 作者格式、Bundle 和官方 Adapter 的品牌化 Extension。
 *
 * @param options 可选的 Hook ID 白名单。
 * @returns 参与 Core 固定生命周期的 Hooks Extension。
 */
export function hooks(
  options: HooksExtensionOptions = {},
): AcpluginExtension<DiscoveredHooks | undefined, BuiltHooks> {
  validateOptions(options);
  /** 每个 Extension 实例独占且不可被作者随后修改的 include 集合。 */
  const include = normalizeInclude(options.include);
  /** configResolved 刷新的已配置 Platform ID 快照。 */
  let configuredPlatforms: ReadonlySet<string> = new Set<string>();
  return defineExtension<DiscoveredHooks | undefined, BuiltHooks>({
    name: EXTENSION_NAME,
    apiVersion: '1',
    /** 保存当前构建 Platform 身份，供平台事件和专属字段提前验证。 */
    configResolved: (context) => {
      configuredPlatforms = new Set(context.platforms.map(platform => platform.id));
    },
    /** 扫描 Extension 独占的 `src/hooks` 作者格式。 */
    discover: context => discoverHooks(context, include),
    /** 在 Bundle 前验证规范事件、平台范围和 Adapter Schema。 */
    validate: (context, discovered) => discovered === undefined
      ? undefined
      : validateHooks(context, discovered, { configuredPlatforms }),
    /** 每个 Hook 只生成一份由多个 Adapter 复用的平台中立 Handler。 */
    build: (context, discovered) => discovered === undefined
      ? Object.freeze({ hooks: Object.freeze([]) })
      : buildHooks(context, discovered),
    adapters: createHooksAdapters(),
  });
}

export default hooks;
