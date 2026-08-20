/** managed-rolldown options 的严格数据规范化。 */
import type {
  EngineInputOptions,
  EngineOutputOptions,
  EnginePlugin,
} from '../engine-loader.js';

/** Rolldown 1.2.2 中 managed Profile 显式支持的 input 字段。 */
const INPUT_FIELDS = new Set([
  'external',
  'resolve',
  'platform',
  'shimMissingExports',
  'treeshake',
  'onLog',
  'moduleTypes',
  'experimental',
  'transform',
  'checks',
  'makeAbsoluteExternalsRelative',
  'preserveEntrySignatures',
  'optimization',
  'context',
]);

/** 由 Core 接管或属于另一条 write/watch/devtools 生命周期的 input 字段。 */
const FORBIDDEN_INPUT_FIELDS = new Set(['input', 'cwd', 'logLevel', 'onwarn', 'watch', 'devtools', 'output']);

/** Rolldown 1.2.2 中 generate() 可使用的 output 字段。 */
const OUTPUT_FIELDS = new Set([
  'exports',
  'hashCharacters',
  'format',
  'sourcemap',
  'sourcemapBaseUrl',
  'sourcemapFileNames',
  'sourcemapDebugIds',
  'sourcemapIgnoreList',
  'sourcemapPathTransform',
  'sourcemapExcludeSources',
  'banner',
  'footer',
  'postBanner',
  'postFooter',
  'intro',
  'outro',
  'extend',
  'esModule',
  'assetFileNames',
  'entryFileNames',
  'chunkFileNames',
  'sanitizeFileName',
  'minify',
  'name',
  'globals',
  'paths',
  'generatedCode',
  'externalLiveBindings',
  'inlineDynamicImports',
  'dynamicImportInCjs',
  'manualChunks',
  'codeSplitting',
  'advancedChunks',
  'legalComments',
  'comments',
  'polyfillRequire',
  'hoistTransitiveImports',
  'preserveModules',
  'virtualDirname',
  'preserveModulesRoot',
  'topLevelVar',
  'minifyInternalExports',
  'keepNames',
  'strictExecutionOrder',
  'strict',
]);

/** Core 永远不会传给 generate() 的物理输出字段。 */
const FORBIDDEN_OUTPUT_FIELDS = new Set(['dir', 'file']);

/** Rolldown Plugin 的全部当前公开 hook。 */
const PLUGIN_HOOKS = new Set([
  'onLog',
  'options',
  'outputOptions',
  'buildStart',
  'resolveId',
  'resolveDynamicImport',
  'load',
  'transform',
  'moduleParsed',
  'buildEnd',
  'renderStart',
  'renderChunk',
  'augmentChunkHash',
  'resolveFileUrl',
  'renderError',
  'generateBundle',
  'closeBundle',
  'banner',
  'footer',
  'intro',
  'outro',
]);

/** 接受后却不会在 generate-only Host 执行的 Plugin hook。 */
const FORBIDDEN_PLUGIN_HOOKS = new Set(['writeBundle', 'watchChange', 'closeWatcher']);

/** Plugin 非 hook 元数据字段。 */
const PLUGIN_FIELDS = new Set(['name', 'version', 'meta', 'api']);

/** 当前 managed Profile 拒绝依赖 watch/direct-write 语义的实验字段。 */
const FORBIDDEN_EXPERIMENTAL_FIELDS = new Set(['devMode', 'incrementalBuild']);

/** options hook 不得原地或通过返回值改写的 Core 输入边界。 */
const PROTECTED_INPUT_HOOK_FIELDS = new Set(['input', 'cwd', 'plugins', 'logLevel', 'onwarn', 'watch', 'devtools', 'output', 'tsconfig']);

/** outputOptions hook 不得原地或通过返回值改写的 Core 输出边界。 */
const PROTECTED_OUTPUT_HOOK_FIELDS = new Set(['dir', 'file', 'plugins']);

/**
 * 仅读取已验证的 data property。
 *
 * @param input 待检查结构。
 * @param label 稳定诊断标签。
 * @returns 不包含 accessor 或 Symbol 语义的字段集。
 */
function dataProperties(input: unknown, label: string): Record<string, PropertyDescriptor> {
  if (typeof input !== 'object' || input === null || Array.isArray(input))
    throw new TypeError(`${label} must be an object.`);
  if (Object.getOwnPropertySymbols(input).length > 0)
    throw new TypeError(`${label} must not contain symbol properties.`);
  /** 完整 descriptor 集避免在验证前触发 getter。 */
  const descriptors = Object.getOwnPropertyDescriptors(input);
  for (const [field, descriptor] of Object.entries(descriptors)) {
    if (!('value' in descriptor))
      throw new TypeError(`${label}.${field} must be a data property.`);
  }
  return descriptors;
}

/**
 * 复制一个 Rolldown 参数值，与调用方所持嵌套容器解除引用。
 *
 * @param value 待快照值。
 * @param label 当前字段路径。
 * @param seen 循环与重复引用记录。
 * @returns 保留函数与可信实例 identity 的冻结结构副本。
 */
function snapshotValue(value: unknown, label: string, seen = new Map<object, unknown>()): unknown {
  if (value === null || typeof value !== 'object')
    return value;
  /** RegExp 是 Rolldown filter 中的值对象，需要复制 lastIndex 而不是冻结原对象。 */
  if (value instanceof RegExp) {
    /** 保留 source/flags/lastIndex 的新 RegExp identity。 */
    const copy = new RegExp(value.source, value.flags);
    copy.lastIndex = value.lastIndex;
    return copy;
  }
  /** Uint8Array 是 output/plugin 可用的精确字节值。 */
  if (value instanceof Uint8Array)
    return Uint8Array.from(value);
  /** URL 与其他内建或 Plugin 实例保留可信 identity。 */
  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null)
    return value;
  /** 已复制容器用于保留重复引用和终止循环。 */
  const existing = seen.get(value);
  if (existing !== undefined)
    return existing;
  /** 数组和 plain object 使用对应容器复制。 */
  /** 与原值容器类型一致的可写中间副本。 */
  const copy: Record<PropertyKey, unknown> | unknown[] = Array.isArray(value) ? [] : {};
  seen.set(value, copy);
  /** 数组允许 index/length data property，但仍拒绝 accessor 和 Symbol。 */
  const descriptors = Array.isArray(value)
    ? Object.getOwnPropertyDescriptors(value)
    : dataProperties(value, label);
  if (Array.isArray(value)) {
    if (Object.getOwnPropertySymbols(value).length > 0)
      throw new TypeError(`${label} must not contain symbol properties.`);
    for (const [field, descriptor] of Object.entries(descriptors)) {
      if (!('value' in descriptor))
        throw new TypeError(`${label}.${field} must be a data property.`);
    }
  }
  for (const [field, descriptor] of Object.entries(descriptors)) {
    if (Array.isArray(copy) && field === 'length')
      continue;
    (copy as Record<string, unknown>)[field] = snapshotValue(descriptor.value, `${label}.${field}`, seen);
  }
  return Object.freeze(copy);
}

/**
 * 校验顶层 option 字段并建立结构快照。
 *
 * @param input 调用方提供的 option 对象。
 * @param allowed 当前精确 Rolldown 版本已审核字段。
 * @param forbidden Core 接管字段。
 * @param label 稳定诊断标签。
 * @returns 与调用方容器解除引用的副本。
 */
function snapshotOptions(
  input: unknown,
  allowed: ReadonlySet<string>,
  forbidden: ReadonlySet<string>,
  label: string,
): Record<string, unknown> {
  if (input === undefined)
    return {};
  /** 顶层 options 的完整 data property。 */
  const descriptors = dataProperties(input, label);
  /** 先验证全部字段，不向未知未来能力默默放行。 */
  for (const field of Object.keys(descriptors)) {
    if (forbidden.has(field))
      throw new TypeError(`${label}.${field} is managed by Core.`);
    if (field !== 'plugins' && !allowed.has(field))
      throw new TypeError(`${label}.${field} is not supported by this managed Rolldown version.`);
  }
  /** 参数副本仅包含已审核 data property。 */
  const snapshot: Record<string, unknown> = {};
  for (const [field, descriptor] of Object.entries(descriptors)) {
    if (field !== 'plugins')
      snapshot[field] = snapshotValue(descriptor.value, `${label}.${field}`);
  }
  return snapshot;
}

/**
 * 展开 Promise/Array/Falsy Rolldown Plugin option。
 *
 * @param option 递归 Plugin 声明。
 * @param label 当前字段路径。
 * @param target 展平后的 Plugin 容器。
 */
async function flattenPlugins(
  option: unknown,
  label: string,
  target: EnginePlugin[],
): Promise<void> {
  /** PromiseLike 解析后立即复制其返回外壳。 */
  /** 当前展平节点解析 PromiseLike 后的值。 */
  const value: unknown = typeof option === 'object' && option !== null && 'then' in option
    ? await Promise.resolve(option)
    : option;
  if (value === false || value === null || value === undefined)
    return;
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1)
      await flattenPlugins(value[index], `${label}[${index}]`, target);
    return;
  }
  target.push(snapshotPlugin(value, label));
}

/**
 * 复制 Plugin hook 与 filter 外壳，固定当次执行的函数引用。
 *
 * @param value 函数或 object-hook。
 * @param label 当前 hook 路径。
 * @returns 与调用方 hook 容器解除引用的副本。
 */
function snapshotHook(value: unknown, label: string, hook: string): unknown {
  if (typeof value === 'function')
    return wrapProtectedOptionsHook(value as (this: unknown, ...args: unknown[]) => unknown, hook, label);
  if (typeof value === 'string')
    return value;
  /** object-hook 外壳的全部 data property。 */
  const descriptors = dataProperties(value, label);
  /** object-hook 只允许 Rolldown 公开的外壳字段。 */
  const allowed = new Set(['handler', 'order', 'filter', 'sequential']);
  for (const field of Object.keys(descriptors)) {
    if (!allowed.has(field))
      throw new TypeError(`${label}.${field} is not a supported Plugin hook property.`);
  }
  if (typeof descriptors.handler?.value !== 'function' && typeof descriptors.handler?.value !== 'string')
    throw new TypeError(`${label}.handler must be callable or a string addon.`);
  /** handler identity 保留，filter/order 容器建立快照。 */
  const result: Record<string, unknown> = {
    handler: typeof descriptors.handler.value === 'function'
      ? wrapProtectedOptionsHook(descriptors.handler.value as (this: unknown, ...args: unknown[]) => unknown, hook, label)
      : descriptors.handler.value,
  };
  for (const field of ['order', 'filter', 'sequential']) {
    if (descriptors[field] !== undefined)
      result[field] = snapshotValue(descriptors[field]!.value, `${label}.${field}`);
  }
  return Object.freeze(result);
}

/**
 * 捕获一组受保护 option 字段的 presence 与 identity。
 *
 * @param options Rolldown 传入或 Plugin 返回的 options。
 * @param fields 受 Core 接管字段。
 * @param label 稳定诊断标签。
 * @returns 用于 hook 前后对比的快照。
 */
function protectedFieldSnapshot(
  options: unknown,
  fields: ReadonlySet<string>,
  label: string,
): ReadonlyMap<string, { readonly present: boolean; readonly value?: unknown }> {
  /** 受检 options 的全部 data property。 */
  const descriptors = dataProperties(options, label);
  return new Map([...fields].map(field => [field, Object.freeze({
    present: descriptors[field] !== undefined,
    ...(descriptors[field] === undefined ? {} : { value: descriptors[field]!.value }),
  })]));
}

/**
 * 确认 Plugin hook 没有改写 Core-owned option。
 *
 * @param baseline hook 执行前快照。
 * @param candidate hook 执行后原对象或返回对象。
 * @param fields 受保护字段。
 * @param label 稳定诊断标签。
 */
function assertProtectedFields(
  baseline: ReadonlyMap<string, { readonly present: boolean; readonly value?: unknown }>,
  candidate: unknown,
  fields: ReadonlySet<string>,
  label: string,
): void {
  /** hook 执行后对象的受保护字段快照。 */
  const current = protectedFieldSnapshot(candidate, fields, label);
  for (const field of fields) {
    /** hook 执行前的字段 presence/identity。 */
    const before = baseline.get(field)!;
    /** hook 执行后的字段 presence/identity。 */
    const after = current.get(field)!;
    if (before.present !== after.present || (before.present && !Object.is(before.value, after.value)))
      throw new TypeError(`${label} must not change Core-managed field "${field}".`);
  }
}

/**
 * 包装 options/outputOptions hook，阻断对 Core-owned 字段的原地和返回值改写。
 *
 * @param handler trusted Plugin 原始 handler。
 * @param hook 当前 hook 名。
 * @param label 稳定诊断标签。
 * @returns 保留 this/参数/返回语义的受管 handler。
 */
function wrapProtectedOptionsHook(
  handler: (this: unknown, ...args: unknown[]) => unknown,
  hook: string,
  label: string,
): (this: unknown, ...args: unknown[]) => unknown {
  /** 只有 options/outputOptions 存在 Core-owned 字段集。 */
  const fields = hook === 'options'
    ? PROTECTED_INPUT_HOOK_FIELDS
    : hook === 'outputOptions'
      ? PROTECTED_OUTPUT_HOOK_FIELDS
      : undefined;
  if (fields === undefined)
    return handler;
  if (hook === 'outputOptions') {
    return function managedOutputOptionsHook(this: unknown, ...args: unknown[]): unknown {
      /** Rolldown 传入的当前 output options。 */
      const options = args[0];
      /** outputOptions 执行前的 Core-owned 字段快照。 */
      const baseline = protectedFieldSnapshot(options, fields, `${label} input`);
      /** trusted outputOptions handler 的原始返回值。 */
      const result = handler.apply(this, args);
      /** outputOptions 是 Rolldown 同步 hook，thenable 是运行时契约违反。 */
      if (typeof result === 'object' && result !== null && 'then' in result)
        throw new TypeError(`${label} must be synchronous.`);
      assertProtectedFields(baseline, options, fields, `${label} input`);
      if (result !== undefined && result !== null)
        assertProtectedFields(baseline, result, fields, `${label} result`);
      return result;
    };
  }
  return async function managedOptionsHook(this: unknown, ...args: unknown[]): Promise<unknown> {
    /** Rolldown 传入的当前 input options。 */
    const options = args[0];
    /** options 执行前的 Core-owned 字段快照。 */
    const baseline = protectedFieldSnapshot(options, fields, `${label} input`);
    /** trusted options handler 解析后的原始返回值。 */
    const result = await handler.apply(this, args);
    assertProtectedFields(baseline, options, fields, `${label} input`);
    if (result !== undefined && result !== null)
      assertProtectedFields(baseline, result, fields, `${label} result`);
    return result;
  };
}

/**
 * 校验并复制一个 trusted managed Plugin。
 *
 * @param value 展平后的 Plugin 候选。
 * @param label Plugin option 位置。
 * @returns Rolldown 可直接执行的冻结外壳。
 */
function snapshotPlugin(value: unknown, label: string): EnginePlugin {
  /** trusted Plugin 外壳的全部 data property。 */
  const descriptors = dataProperties(value, label);
  for (const field of Object.keys(descriptors)) {
    if (FORBIDDEN_PLUGIN_HOOKS.has(field))
      throw new TypeError(`${label}.${field} is forbidden because Core never runs write/watch lifecycles.`);
    if (!PLUGIN_FIELDS.has(field) && !PLUGIN_HOOKS.has(field))
      throw new TypeError(`${label}.${field} is not supported by this managed Rolldown version.`);
  }
  if (typeof descriptors.name?.value !== 'string' || descriptors.name.value.length === 0)
    throw new TypeError(`${label}.name must be a non-empty string.`);
  /** Plugin 外壳保留 api identity，其他容器与 hook 外壳建立快照。 */
  const plugin: Record<string, unknown> = { name: descriptors.name.value };
  for (const field of ['version', 'meta']) {
    if (descriptors[field] !== undefined)
      plugin[field] = snapshotValue(descriptors[field]!.value, `${label}.${field}`);
  }
  if (descriptors.api !== undefined)
    plugin.api = descriptors.api.value;
  for (const hook of PLUGIN_HOOKS) {
    if (descriptors[hook] !== undefined)
      plugin[hook] = snapshotHook(descriptors[hook]!.value, `${label}.${hook}`, hook);
  }
  return Object.freeze(plugin) as unknown as EnginePlugin;
}

/** 快照后的 Rolldown input options 与已展平 Plugin。 */
export interface NormalizedManagedInput {
  readonly options: EngineInputOptions;
  readonly plugins: readonly EnginePlugin[];
  readonly tsconfig?: false | import('../../contracts/services.js').SourceFileRef;
}

/** 快照后的 Rolldown output options 与已展平 Plugin。 */
export interface NormalizedManagedOutput {
  readonly options: EngineOutputOptions;
  readonly plugins: readonly EnginePlugin[];
}

/**
 * 展开、校验并快照一组 Rolldown Plugin option。
 *
 * @param option 输入或输出 Plugin option。
 * @param label 稳定诊断标签。
 * @returns 固定顺序的 Plugin 外壳数组。
 */
async function snapshotPlugins(
  option: unknown,
  label: string,
): Promise<readonly EnginePlugin[]> {
  /** 递归展平的中间列表不向 Rolldown 暴露。 */
  const flattened: EnginePlugin[] = [];
  await flattenPlugins(option, label, flattened);
  return Object.freeze(flattened);
}

/**
 * 快照 managed input options 与其 Plugin 树。
 *
 * @param input 调用方 input options。
 * @returns 已审核的 Rolldown input 副本。
 */
export async function normalizeManagedInput(input: unknown): Promise<NormalizedManagedInput> {
  /** 原始 input options 的 data property，仅用于取得 Plugin option。 */
  const descriptors = input === undefined ? {} : dataProperties(input, 'inputOptions');
  /** tsconfig 是 Core-owned SourceRef 能力，不进入通用结构复制。 */
  const tsconfig = descriptors.tsconfig?.value;
  if (tsconfig !== undefined && tsconfig !== false && (typeof tsconfig !== 'object' || tsconfig === null))
    throw new TypeError('inputOptions.tsconfig must be false or an authorized SourceFileRef.');
  /** 排除受管 tsconfig 后的 input option data property 容器。 */
  const snapshotInput = Object.fromEntries(Object.entries(descriptors)
    .filter(([field]) => field !== 'tsconfig')
    .map(([field, descriptor]) => [field, descriptor.value]));
  /** 不含 plugins/tsconfig 的已审核 input option 结构快照。 */
  const snapshot = snapshotOptions(snapshotInput, INPUT_FIELDS, FORBIDDEN_INPUT_FIELDS, 'inputOptions');
  if (snapshot.experimental !== undefined) {
    /** 已快照 experimental 对象的全部 data property。 */
    const experimental = dataProperties(snapshot.experimental, 'inputOptions.experimental');
    for (const field of FORBIDDEN_EXPERIMENTAL_FIELDS) {
      if (experimental[field] !== undefined)
        throw new TypeError(`inputOptions.experimental.${field} is forbidden by the managed lifecycle.`);
    }
  }
  /** tsconfig 默认关闭，避免 Rolldown 隐式搜索未授权工程文件。 */
  return Object.freeze({
    options: Object.freeze({
      ...snapshot,
      tsconfig: false,
    }) as EngineInputOptions,
    plugins: await snapshotPlugins(descriptors.plugins?.value, 'inputOptions.plugins'),
    ...(tsconfig === undefined ? {} : { tsconfig: tsconfig as false | import('../../contracts/services.js').SourceFileRef }),
  });
}

/**
 * 快照一组 managed output options 与其 Plugin 树。
 *
 * @param input 调用方 output options。
 * @param label 包含 output ID 的诊断标签。
 * @returns 已审核的 Rolldown output 副本。
 */
export async function normalizeManagedOutput(input: unknown, label: string): Promise<NormalizedManagedOutput> {
  /** 不含 plugins 的已审核 output option 结构快照。 */
  const snapshot = snapshotOptions(input, OUTPUT_FIELDS, FORBIDDEN_OUTPUT_FIELDS, label);
  /** 原始 output options 的 data property，仅用于取得 Plugin option。 */
  const descriptors = dataProperties(input, label);
  return Object.freeze({
    options: Object.freeze(snapshot) as EngineOutputOptions,
    plugins: await snapshotPlugins(descriptors.plugins?.value, `${label}.plugins`),
  });
}
