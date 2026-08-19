import {
  defineExtension,
  type AcpluginExtension,
  type JsonObject,
  type PortableNodeCompileOptions,
} from '@tokenroll/acplugin/sdk';
import { buildHooks, type BuiltHooks } from './build.js';
import { HOOK_ID_PATTERN } from './constants.js';
import { createHooksContributors } from './contributors/index.js';
import {
  discoverHooks,
  type DiscoveredHooks,
  type ValidatedHooks,
  validateHooks,
} from './discovery.js';

export { EXTENSION_NAME } from './constants.js';
export {
  CLAUDE_CODE_PLATFORM_EVENTS,
  HOOK_EVENTS,
} from './types.js';
export type {
  ClaudeCodeHookOptions,
  ClaudeCodePlatformHookEvent,
  CodexHookOptions,
  HookAdvisoryResult,
  HookContextResult,
  HookDecisionResult,
  Hook,
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

/** 创建 Hooks Extension 时可声明的作者资源和编译参数。 */
export interface HooksExtensionOptions {
  /** 只构建这些 `src/hooks/<id>`；省略时构建全部。 */
  readonly include?: readonly string[];
  /** 复用 Core `portable-node` 的公共纯 JSON 编译参数。 */
  readonly compile?: PortableNodeCompileOptions;
}

/** 进入 defineExtension 的 JSON-safe options 形态。 */
type HooksJsonOptions = JsonObject;

/** Hooks Extension factory 允许的精确字段。 */
const OPTION_FIELDS = new Set(['include', 'compile']);

/** 校验并复制可选 Hook ID 白名单。 */
function normalizedInclude(include: HooksExtensionOptions['include']): readonly string[] | undefined {
  if (include === undefined)
    return undefined;
  if (!Array.isArray(include) || include.some(id => typeof id !== 'string' || !HOOK_ID_PATTERN.test(id)))
    throw new TypeError('Hooks include must contain lowercase kebab-case IDs.');
  if (new Set(include).size !== include.length)
    throw new TypeError('Hooks include must not contain duplicate IDs.');
  return Object.freeze([...include].sort());
}

/** 校验 factory options 顶层和可 JSON 复制的 compile 容器。 */
function normalizedOptions(options: HooksExtensionOptions): HooksJsonOptions {
  if (options === null || typeof options !== 'object' || Array.isArray(options))
    throw new TypeError('Hooks options must be a plain object.');
  for (const field of Object.keys(options)) {
    if (!OPTION_FIELDS.has(field))
      throw new TypeError(`Unknown Hooks option "${field}".`);
  }
  /** include 立即复制，compile 的完整 Schema 由 Core portable-node Host 验证。 */
  const include = normalizedInclude(options.include);
  return {
    ...(include === undefined ? {} : { include }),
    ...(options.compile === undefined ? {} : { compile: options.compile as PortableNodeCompileOptions & JsonObject }),
  };
}

/** 创建以 plain TS descriptor、Core Host 和无序 Contributors 实现的 Hooks Extension。 */
export function hooks(options: HooksExtensionOptions = {}): AcpluginExtension<JsonObject, DiscoveredHooks, ValidatedHooks, BuiltHooks> {
  /** normalized 由 defineExtension 再次防御性复制并深度冻结。 */
  const normalized = normalizedOptions(options);
  return defineExtension({
    id: 'hooks',
    apiVersion: '1',
    options: normalized,
    resourceRoots: ['hooks'],
    /** 每个 BuildSession 从 setup integrations 派生不可变平台快照。 */
    createSession({ options: sessionOptions, integrations }) {
      /** platforms 不依赖 factory closure 或 Extension 配置顺序。 */
      const platforms = new Set(integrations.filter(item => item.kind === 'platform').map(item => item.id));
      /** include 从 Core 已复制的 JSON options 建立 Session-local Set。 */
      const normalized = sessionOptions as HooksExtensionOptions;
      /** include 白名单只在当前 Session 内使用。 */
      const include = normalized.include === undefined ? undefined : new Set(normalized.include);
      /** compile 同样只读取 setup 的 frozen options。 */
      const compile = normalized.compile;
      return {
        /** 从 Extension 独占根发现 Hook 作者模块。 */
        discover: context => discoverHooks(context, include),
        /** 校验纯数据 descriptor 并登记跨平台主题。 */
        validate: (context, discovered) => validateHooks(context, discovered, platforms),
        /** 通过 Core portable-node 一次编译可复用的 Handler。 */
        build: async (context, validated) => ({ state: await buildHooks(context, validated, compile) }),
        contributors: createHooksContributors(),
      };
    },
  });
}

export default hooks;
