import type {
  AcpluginExtension,
  AcpluginPlatform,
  ExtensionDefinition,
  JsonObject,
  JsonValue,
  PlatformCapabilities,
  PlatformDefinition,
} from './kernel-types.js';
import { LIFECYCLE_API_VERSION } from './kernel-types.js';

/** Platform ID、Extension ID、Resource root 和 job ID 共用的稳定标识规则。 */
const STABLE_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** 跨 root/SDK/CLI bundle chunk 共享的 Platform 定义品牌。 */
const platformBrand = Symbol.for(`tokenroll.acplugin.platform.${LIFECYCLE_API_VERSION}`);

/** 跨 root/SDK/CLI bundle chunk 共享的 Extension 定义品牌。 */
const extensionBrand = Symbol.for(`tokenroll.acplugin.extension.${LIFECYCLE_API_VERSION}`);

/** Platform definition 唯一允许的公共字段。 */
const platformFields = new Set(['id', 'apiVersion', 'deliveryType', 'strict', 'options', 'capabilities', 'createSession']);

/** Extension definition 唯一允许的公共字段。 */
const extensionFields = new Set(['id', 'apiVersion', 'options', 'resourceRoots', 'createSession']);

/** JSON 规范化递归调用时使用的路径与祖先记录。 */
interface JsonNormalizationState {
  readonly ancestors: Set<object>;
  readonly path: string;
}

/**
 * 按 UTF-16 code unit 比较稳定键。
 *
 * @param left 左侧文本。
 * @param right 右侧文本。
 * @returns 排序比较结果。
 */
function compareCodeUnits(left: string, right: string): number {
  if (left === right)
    return 0;
  return left < right ? -1 : 1;
}

/**
 * 确认对象不携带 accessor、Symbol 或不可见字段语义。
 *
 * @param value 待检查对象。
 * @param label 诊断中的对象角色。
 * @returns 自有字符串字段描述符。
 */
function dataDescriptors(value: object, label: string): Record<string, PropertyDescriptor> {
  /** Symbol 字段既不属于 JSON，也不能成为隐藏定义字段。 */
  const symbols = Object.getOwnPropertySymbols(value);
  if (symbols.length > 0)
    throw new TypeError(`${label} must not contain symbol properties.`);
  /** 所有自有字符串字段的完整描述符。 */
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const [field, descriptor] of Object.entries(descriptors)) {
    if (!('value' in descriptor))
      throw new TypeError(`${label}.${field} must be a data property, not an accessor.`);
  }
  return descriptors;
}

/**
 * 验证对象使用 plain-object 原型。
 *
 * @param value 待检查值。
 * @param label 诊断中的对象角色。
 */
function assertPlainObject(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new TypeError(`${label} must be a plain object.`);
  /** class instance 与自定义 prototype 不属于无行为 contract。 */
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null)
    throw new TypeError(`${label} must be a plain object.`);
}

/**
 * 拒绝定义上的未知字段并返回其数据描述符。
 *
 * @param value 待检查定义对象。
 * @param allowed 允许字段集合。
 * @param label 诊断中的定义角色。
 * @returns 通过检查的数据描述符。
 */
function definitionDescriptors(value: unknown, allowed: ReadonlySet<string>, label: string): Record<string, PropertyDescriptor> {
  assertPlainObject(value, label);
  /** 定义字段必须全部是显式 data property。 */
  const descriptors = dataDescriptors(value, label);
  for (const field of Object.keys(descriptors)) {
    if (!allowed.has(field))
      throw new TypeError(`Unknown ${label} field "${field}".`);
  }
  return descriptors;
}

/**
 * 递归复制并冻结严格 JSON 值。
 *
 * @param value 调用方仍可能持有的原始值。
 * @param state 当前递归祖先与字段路径。
 * @returns 与调用方身份隔离的冻结副本。
 */
function copyJson(value: unknown, state: JsonNormalizationState): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean')
    return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value))
      throw new TypeError(`${state.path} must contain only finite JSON numbers.`);
    return value;
  }
  if (typeof value !== 'object')
    throw new TypeError(`${state.path} must contain only JSON values.`);
  if (state.ancestors.has(value))
    throw new TypeError(`${state.path} must not contain cycles.`);
  state.ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      /** 稀疏数组无法被无歧义地复制成 JSON。 */
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.prototype.hasOwnProperty.call(value, index))
          throw new TypeError(`${state.path} must not contain sparse arrays.`);
      }
      /** 数组不能携带 index/length 之外的隐藏字符串字段。 */
      const descriptors = dataDescriptors(value, state.path);
      for (const field of Object.keys(descriptors)) {
        if (field !== 'length' && !/^(?:0|[1-9][0-9]*)$/.test(field))
          throw new TypeError(`${state.path} arrays must not contain custom properties.`);
      }
      return Object.freeze(value.map((item, index) => copyJson(item, {
        ancestors: state.ancestors,
        path: `${state.path}[${index}]`,
      })));
    }
    assertPlainObject(value, state.path);
    /** JSON 对象只读取已验证的 data descriptors，绝不触发 getter。 */
    const descriptors = dataDescriptors(value, state.path);
    /** 使用普通对象确保公开 options 保持预期 JSON 对象语义。 */
    const result: Record<string, JsonValue> = {};
    for (const field of Object.keys(descriptors).sort(compareCodeUnits)) {
      result[field] = copyJson(descriptors[field]!.value, {
        ancestors: state.ancestors,
        path: `${state.path}.${field}`,
      });
    }
    return Object.freeze(result);
  } finally {
    state.ancestors.delete(value);
  }
}

/**
 * 复制一个严格 JSON 对象。
 *
 * @param value 可省略的原始 options。
 * @param label 诊断中的对象角色。
 * @returns 冻结的 JSON 对象副本。
 */
function copyJsonObject(value: unknown, label: string): Readonly<JsonObject> {
  assertPlainObject(value, label);
  return copyJson(value, { ancestors: new Set<object>(), path: label }) as Readonly<JsonObject>;
}

/**
 * 验证 JSON 容器及全部后代都已冻结。
 *
 * @param value 已通过 JSON 形态校验的候选值。
 * @returns 所有容器都冻结时返回 true。
 */
function isDeeplyFrozenJson(value: unknown): boolean {
  if (value === null || typeof value !== 'object')
    return true;
  if (!Object.isFrozen(value))
    return false;
  if (Array.isArray(value))
    return value.every(isDeeplyFrozenJson);
  return Object.values(value as Record<string, unknown>).every(isDeeplyFrozenJson);
}

/**
 * 复制并验证开放的 Platform capability 数据。
 *
 * @param value 原始 capability 对象。
 * @returns 冻结且完成 nodeRuntime 语义校验的能力副本。
 */
function copyCapabilities(value: unknown): Readonly<PlatformCapabilities> {
  /** 未声明能力与空 capability 对象具有相同语义。 */
  const copied = copyJsonObject(value ?? {}, 'Platform capabilities') as PlatformCapabilities;
  if (copied.nodeRuntime !== undefined) {
    /** nodeRuntime 是 Framework 理解的唯一结构化内建能力。 */
    const runtime = copied.nodeRuntime;
    assertPlainObject(runtime, 'Platform capabilities.nodeRuntime');
    /** 内建能力必须只包含固定的三个协商字段。 */
    const fields = Object.keys(dataDescriptors(runtime, 'Platform capabilities.nodeRuntime')).sort(compareCodeUnits);
    if (fields.length !== 3 || fields[0] !== 'format' || fields[1] !== 'root' || fields[2] !== 'target'
      || runtime.target !== 'node20' || runtime.format !== 'esm' || runtime.root !== 'plugin') {
      throw new TypeError('Platform capabilities.nodeRuntime must declare Node 20 ESM at the Plugin root.');
    }
  }
  return copied;
}

/**
 * 验证稳定 lowercase-kebab 标识。
 *
 * @param value 未知标识值。
 * @param label 诊断中的标识角色。
 * @returns 已验证标识文本。
 */
function stableId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !STABLE_ID_PATTERN.test(value))
    throw new TypeError(`${label} must use lowercase kebab-case.`);
  return value;
}

/**
 * 读取 definition 的已验证 data property。
 *
 * @param descriptors definition 字段描述符。
 * @param field 要读取的字段。
 * @returns 未知字段值。
 */
function definitionValue(descriptors: Record<string, PropertyDescriptor>, field: string): unknown {
  return descriptors[field]?.value;
}

/**
 * 使用共享品牌构造最终 Platform definition。
 *
 * @param definition trusted integration 提交的平台定义。
 * @returns 完成形态校验、复制和冻结的平台定义。
 */
export function definePlatform<const O extends JsonObject>(definition: PlatformDefinition<O>): AcpluginPlatform<O> {
  /** definition 顶层必须是精确 plain-object contract。 */
  const descriptors = definitionDescriptors(definition, platformFields, 'Platform definition');
  /** API version 在任何回调运行前检查。 */
  if (definitionValue(descriptors, 'apiVersion') !== LIFECYCLE_API_VERSION)
    throw new TypeError(`Unsupported Platform API version; expected ${LIFECYCLE_API_VERSION}.`);
  /** delivery type 决定主 Package 的语义而不是输出路径。 */
  const deliveryType = definitionValue(descriptors, 'deliveryType');
  if (deliveryType !== 'plugin' && deliveryType !== 'workspace' && deliveryType !== 'package')
    throw new TypeError('Platform deliveryType must be plugin, workspace, or package.');
  /** 可选 strict override 必须是布尔值。 */
  const strict = definitionValue(descriptors, 'strict');
  if (strict !== undefined && typeof strict !== 'boolean')
    throw new TypeError('Platform strict must be a boolean when provided.');
  /** Session factory 是 definition 唯一持有行为的入口。 */
  const createSession = definitionValue(descriptors, 'createSession');
  if (typeof createSession !== 'function')
    throw new TypeError('Platform createSession must be a function.');
  /** options 总是复制，使调用方后续 mutation 不影响配置。 */
  const options = copyJsonObject(definitionValue(descriptors, 'options') ?? {}, 'Platform options');
  /** capabilities 使用同一 JSON 复制规则并额外验证内建能力。 */
  const capabilities = copyCapabilities(definitionValue(descriptors, 'capabilities'));
  /** 最终外壳不展开原始对象，避免未知继承字段进入实例。 */
  const platform = {
    id: stableId(definitionValue(descriptors, 'id'), 'Platform id'),
    apiVersion: LIFECYCLE_API_VERSION,
    deliveryType,
    ...(strict === undefined ? {} : { strict }),
    options,
    capabilities,
    createSession,
  };
  Object.defineProperty(platform, platformBrand, { value: true, enumerable: false });
  return Object.freeze(platform) as unknown as AcpluginPlatform<O>;
}

/**
 * 验证未知值是否为当前主包工厂创建的完整 Platform definition。
 *
 * @param value 配置加载器收到的候选值。
 * @returns 品牌和完整外壳均有效时返回 true。
 */
export function isAcpluginPlatform(value: unknown): value is AcpluginPlatform {
  if (typeof value !== 'object' || value === null)
    return false;
  /** 共享 Symbol 只解决 bundle identity，完整 shape 仍独立验证。 */
  const candidate = value as Record<PropertyKey, unknown>;
  if (candidate[platformBrand] !== true || !Object.isFrozen(value))
    return false;
  try {
    /** 工厂实例包含共享 registry brand，因此允许这一个已知 Symbol 后检查公共字段。 */
    const symbols = Object.getOwnPropertySymbols(value);
    if (symbols.length !== 1 || symbols[0] !== platformBrand)
      return false;
    /** 品牌不可枚举、不可写且不可配置。 */
    const brand = Object.getOwnPropertyDescriptor(value, platformBrand);
    if (brand?.value !== true || brand.enumerable || brand.writable || brand.configurable)
      return false;
    /** 公共 shape 和深冻 JSON 数据仍必须完整。 */
    const fields = Object.keys(value).sort(compareCodeUnits);
    /** factory 必须始终物化这些规范字段，strict 是唯一可选字段。 */
    const required = ['apiVersion', 'capabilities', 'createSession', 'deliveryType', 'id', 'options'];
    if (fields.some(field => !platformFields.has(field)) || required.some(field => !fields.includes(field)))
      return false;
    if (candidate.apiVersion !== LIFECYCLE_API_VERSION || typeof candidate.id !== 'string' || !STABLE_ID_PATTERN.test(candidate.id)
      || (candidate.deliveryType !== 'plugin' && candidate.deliveryType !== 'workspace' && candidate.deliveryType !== 'package')
      || (candidate.strict !== undefined && typeof candidate.strict !== 'boolean') || typeof candidate.createSession !== 'function')
      return false;
    copyJsonObject(candidate.options, 'Platform options');
    copyCapabilities(candidate.capabilities);
    return isDeeplyFrozenJson(candidate.options) && isDeeplyFrozenJson(candidate.capabilities);
  } catch {
    return false;
  }
}

/**
 * 使用共享品牌构造最终 Extension definition。
 *
 * @param definition trusted integration 提交的 Extension 定义。
 * @returns 完成形态校验、复制和冻结的 Extension 定义。
 */
export function defineExtension<
  const O extends JsonObject,
  D = unknown,
  V = D,
  B = V,
>(definition: ExtensionDefinition<O, D, V, B>): AcpluginExtension<O, D, V, B> {
  /** definition 顶层必须是精确 plain-object contract。 */
  const descriptors = definitionDescriptors(definition, extensionFields, 'Extension definition');
  if (definitionValue(descriptors, 'apiVersion') !== LIFECYCLE_API_VERSION)
    throw new TypeError(`Unsupported Extension API version; expected ${LIFECYCLE_API_VERSION}.`);
  /** Session factory 是 Extension definition 唯一持有行为的入口。 */
  const createSession = definitionValue(descriptors, 'createSession');
  if (typeof createSession !== 'function')
    throw new TypeError('Extension createSession must be a function.');
  /** resource root 必须是互不重复的 srcDir 一级稳定目录名。 */
  const rawRoots = definitionValue(descriptors, 'resourceRoots');
  if (!Array.isArray(rawRoots))
    throw new TypeError('Extension resourceRoots must be an array.');
  /** 已复制的 root 数组隔离调用方 mutation。 */
  const resourceRoots = rawRoots.map(root => stableId(root, 'Extension resource root'));
  if (new Set(resourceRoots).size !== resourceRoots.length)
    throw new TypeError('Extension resourceRoots must not contain duplicates.');
  /** options 与 Platform 使用完全相同的 JSON contract。 */
  const options = copyJsonObject(definitionValue(descriptors, 'options') ?? {}, 'Extension options');
  /** 最终外壳仅包含 v2 definition 字段。 */
  const extension = {
    id: stableId(definitionValue(descriptors, 'id'), 'Extension id'),
    apiVersion: LIFECYCLE_API_VERSION,
    options,
    resourceRoots: Object.freeze(resourceRoots),
    createSession,
  };
  Object.defineProperty(extension, extensionBrand, { value: true, enumerable: false });
  return Object.freeze(extension) as unknown as AcpluginExtension<O, D, V, B>;
}

/**
 * 验证未知值是否为当前主包工厂创建的完整 Extension definition。
 *
 * @param value 配置加载器收到的候选值。
 * @returns 品牌和完整外壳均有效时返回 true。
 */
export function isAcpluginExtension(value: unknown): value is AcpluginExtension {
  if (typeof value !== 'object' || value === null)
    return false;
  /** 共享 Symbol 只解决 bundle identity，完整 shape 仍独立验证。 */
  const candidate = value as Record<PropertyKey, unknown>;
  if (candidate[extensionBrand] !== true || !Object.isFrozen(value))
    return false;
  try {
    /** 工厂实例只允许自己的不可变共享 registry brand。 */
    const symbols = Object.getOwnPropertySymbols(value);
    if (symbols.length !== 1 || symbols[0] !== extensionBrand)
      return false;
    /** 品牌必须由 defineProperty 的默认只读策略创建。 */
    const brand = Object.getOwnPropertyDescriptor(value, extensionBrand);
    if (brand?.value !== true || brand.enumerable || brand.writable || brand.configurable)
      return false;
    /** 公共字段不能在工厂之后被伪造或遗漏。 */
    const fields = Object.keys(value).sort(compareCodeUnits);
    /** Extension factory 始终物化完整的五字段外壳。 */
    const required = ['apiVersion', 'createSession', 'id', 'options', 'resourceRoots'];
    if (fields.some(field => !extensionFields.has(field)) || required.some(field => !fields.includes(field)))
      return false;
    if (candidate.apiVersion !== LIFECYCLE_API_VERSION || typeof candidate.id !== 'string' || !STABLE_ID_PATTERN.test(candidate.id)
      || typeof candidate.createSession !== 'function' || !Array.isArray(candidate.resourceRoots)
      || !Object.isFrozen(candidate.resourceRoots) || !isDeeplyFrozenJson(candidate.options))
      return false;
    /** 再次运行纯验证，确保跨 bundle 输入仍满足完整 shape。 */
    copyJsonObject(candidate.options, 'Extension options');
    /** 所有 root 再次通过稳定 ID 校验并检查唯一性。 */
    const roots = candidate.resourceRoots.map(root => stableId(root, 'Extension resource root'));
    return new Set(roots).size === roots.length;
  } catch {
    return false;
  }
}
