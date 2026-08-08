import type {
  Artifact,
  ArtifactInput,
  BuildCommand,
  BuildMode,
  ComponentKind,
  CompatibilityLevel,
  MetadataDisposition,
  PluginMetadata,
  PluginProject,
  TypeScriptModuleLoader,
} from './types.js';

/** Platform 与 Extension 在 acplugin 1.0 中共同使用的 API 版本。 */
export const LIFECYCLE_API_VERSION = '1' as const;

/** Platform ID 的类型品牌；该 Symbol 不导出，外部对象不能伪造名义类型。 */
declare const platformIdBrand: unique symbol;

/** Platform 实例的运行时品牌；使用模块私有 Symbol 阻止 shape-compatible 对象绕过校验。 */
const platformBrand: unique symbol = Symbol('acplugin.platform');

/** Extension 实例的运行时品牌；只由 defineExtension 写入。 */
const extensionBrand: unique symbol = Symbol('acplugin.extension');

/** Platform ID 必须满足的小写 kebab-case 规则。 */
const PLATFORM_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** 同步值或 Promise 值组成的生命周期返回类型。 */
export type Awaitable<T> = T | Promise<T>;

/** 可确定性序列化的只读 JSON 值。 */
export type JsonValue
  = | null
    | boolean
    | number
    | string
    | readonly JsonValue[]
    | { readonly [key: string]: JsonValue };

/** 可作为 Platform 专属 Component 字段根节点的只读 JSON 对象。 */
export type JsonObject = { readonly [key: string]: JsonValue };

/** Document extension point 与 patch 使用的字段路径。 */
export type DocumentFieldPath = readonly string[];

/** 开放的第三方 Platform 标识，不限制为内置平台联合类型。 */
export type PlatformId = string & { readonly [platformIdBrand]: true };

/** Platform 主交付单元支持的安装形态。 */
export type PlatformDeliveryType = 'plugin' | 'workspace' | 'package';

/** DeliveryUnit 在一次构建中的职责。 */
export type DeliveryUnitRole = 'primary' | 'distribution';

/** 主交付与 Marketplace Distribution 可使用的单元类型。 */
export type DeliveryUnitType = PlatformDeliveryType | 'marketplace';

/** Platform 拥有的结构化 Document 序列化格式。 */
export type DocumentFormat = 'json' | 'yaml' | 'toml' | 'frontmatter';

/** Document 在主交付单元中的物化策略。 */
export type DocumentEmission = 'required' | 'omit-if-empty';

/** 提供给只读生命周期的 Platform 身份快照。 */
export interface PlatformDescription {
  readonly id: PlatformId;
  readonly apiVersion: typeof LIFECYCLE_API_VERSION;
  readonly deliveryType: PlatformDeliveryType;
  readonly strict: boolean;
}

/** Adapter 可见的 Platform 身份，不暴露当前构建的严格度等配置策略。 */
export type PlatformAdapterDescription = Omit<PlatformDescription, 'strict'>;

/** 提供给只读生命周期的 Extension 身份快照。 */
export interface ExtensionDescription {
  readonly name: string;
  readonly apiVersion: typeof LIFECYCLE_API_VERSION;
}

/** Platform 在序列化前拥有并通过逻辑 ID 暴露的只读 Document。 */
export interface DraftDocument<T = JsonValue> {
  readonly id: string;
  readonly path: string;
  readonly format: DocumentFormat;
  readonly owner: `platform:${string}`;
  readonly value: Readonly<T>;
  /** required 默认必须序列化；omit-if-empty 只允许省略空对象。 */
  readonly emission?: DocumentEmission;
  readonly extensionPoints: readonly DocumentFieldPath[];
}

/** Platform prepare 阶段提交给 Core 接管的初始 Draft。 */
export interface PlatformDraftInput {
  readonly documents: readonly DraftDocument[];
  readonly artifacts: readonly ArtifactInput[];
}

/** Platform 请求 Core 物化并验证的交付单元输入。 */
export interface DeliveryUnitInput {
  readonly id: string;
  readonly role: DeliveryUnitRole;
  readonly type: DeliveryUnitType;
  readonly artifacts: readonly ArtifactInput[];
}

/** Core 完成 owner、hash、mode 与 size 校验后的不可变交付单元。 */
export interface DeliveryUnit {
  readonly id: string;
  readonly platform: PlatformId;
  readonly role: DeliveryUnitRole;
  readonly type: DeliveryUnitType;
  readonly artifacts: readonly Artifact[];
}

/** Extension 只能在 Platform 声明的 extension point 新增字段的 patch。 */
export interface DocumentAddPatch {
  readonly document: string;
  readonly path: DocumentFieldPath;
  readonly value: JsonValue;
}

/** 生命周期 Hook 可提交、由后续 Collector 统一清理的结构化诊断输入。 */
export interface DiagnosticInput {
  readonly code: string;
  readonly severity: 'error' | 'warning';
  readonly message: string;
  readonly phase?: string;
  readonly location?: { readonly path: string; readonly line?: number; readonly column?: number };
  readonly fieldPath?: readonly (string | number)[];
  readonly hint?: string;
}

/** Platform 或 Adapter 可提交、由当前 Platform 自动附加身份的兼容性输入。 */
export interface CompatibilityInput {
  readonly subject: string;
  readonly capability: string;
  readonly level: CompatibilityLevel;
  readonly transformation?: string;
  readonly reason: string;
  readonly causes?: readonly string[];
}

/** Platform 提交统一元数据字段最终去向时不需要重复提供自身身份。 */
export interface MetadataDispositionInput {
  readonly field: string;
  readonly disposition: MetadataDisposition;
  readonly output?: string;
  readonly reason: string;
}

/** 所有生命周期 Context 都携带的稳定命令、模式和诊断出口。 */
export interface LifecycleContext {
  readonly command: BuildCommand;
  readonly mode: BuildMode;
  readonly reportDiagnostic: (diagnostic: DiagnosticInput) => void;
}

/** configResolved 阶段可读取且不包含最终输出写入器的配置快照。 */
export interface LifecycleConfigSnapshot {
  readonly root: string;
  readonly srcDir: string;
  readonly metadata: PluginMetadata;
  readonly strict: boolean;
}

/** Platform 与 Extension configResolved Hook 使用的最小只读上下文。 */
export interface ConfigResolvedContext extends LifecycleContext {
  readonly config: LifecycleConfigSnapshot;
  readonly platforms: readonly PlatformDescription[];
  readonly extensions: readonly ExtensionDescription[];
}

/** Platform 校验单个 Component 专属字段时可读取的稳定身份。 */
export interface ComponentDescription {
  readonly kind: ComponentKind;
  readonly id: string;
  readonly sourcePath: string;
}

/** Scanner 调用 Platform 字段校验器时提供的只读上下文。 */
export interface PlatformComponentValidationContext extends LifecycleContext {
  readonly component: ComponentDescription;
  readonly fields: Readonly<JsonObject>;
}

/** buildStart 阶段可读取的进程环境与当前对象独占工作目录。 */
export interface BuildStartContext extends LifecycleContext {
  readonly projectRoot: string;
  readonly workDir: string;
  readonly environment: Readonly<Record<string, string | undefined>>;
}

/** Extension discover 阶段用于扫描自有作者格式的受限上下文。 */
export interface ExtensionDiscoverContext extends LifecycleContext {
  readonly srcDir: string;
  readonly workDir: string;
  readonly loadTypeScriptModule: TypeScriptModuleLoader;
}

/** Extension validate 阶段读取规范工程的上下文。 */
export interface ExtensionValidateContext extends LifecycleContext {
  readonly project: PluginProject;
}

/** Extension build 阶段生成横向 Built State 和临时文件的上下文。 */
export interface ExtensionBuildContext extends LifecycleContext {
  readonly project: PluginProject;
  readonly workDir: string;
  /** 登记本次构建实际读取的源码或依赖文件，使 dev 可以跟踪完整生成图。 */
  readonly addWatchFile: (file: string) => void;
}

/** Platform prepare 阶段创建初始 Draft 所需的上下文。 */
export interface PlatformPrepareContext extends LifecycleContext {
  readonly project: PluginProject;
  readonly options: Readonly<Record<string, JsonValue>>;
  readonly workDir: string;
  readonly reportCompatibility: (entry: CompatibilityInput) => void;
  readonly reportMetadata: (entry: MetadataDispositionInput) => void;
}

/** Platform generateBundle 阶段读取完成 Adapter 合并后 Draft 的上下文。 */
export interface PlatformGenerateContext extends LifecycleContext {
  readonly project: PluginProject;
  readonly documents: readonly DraftDocument[];
  readonly artifacts: readonly ArtifactInput[];
  readonly workDir: string;
  readonly reportCompatibility: (entry: CompatibilityInput) => void;
}

/** Platform validateBundle 阶段只读访问的临时物化候选。 */
export interface MaterializedCandidate {
  readonly root: string;
  readonly unit: DeliveryUnit;
}

/** Platform 对主单元或 Distribution 执行最终校验的上下文。 */
export interface PlatformValidateContext extends LifecycleContext {
  readonly candidate: MaterializedCandidate;
}

/** Platform 组合 Marketplace 等 Distribution 时使用的受限上下文。 */
export interface PlatformDistributionContext extends LifecycleContext {
  readonly project: PluginProject;
  readonly options: Readonly<Record<string, JsonValue>>;
  readonly workDir: string;
}

/** buildEnd 可观察且不直接泄露任意异常对象的失败摘要。 */
export interface BuildFailureSummary {
  readonly name: string;
  readonly message: string;
}

/** 成功、诊断失败或异常后都传给已初始化对象的清理上下文。 */
export interface BuildEndContext extends LifecycleContext {
  readonly projectRoot: string;
  readonly workDir: string;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly status: 'success' | 'failed';
  readonly error?: BuildFailureSummary;
}

/** Extension Adapter 能读取和增量修改的唯一 Platform Draft 边界。 */
export interface PlatformAdapterContext extends LifecycleContext {
  readonly platform: PlatformAdapterDescription;
  readonly project: PluginProject;
  readonly getDocument: <T = JsonValue>(id: string) => Readonly<T> | undefined;
  readonly emitArtifact: (input: ArtifactInput) => void;
  readonly patchDocument: (input: DocumentAddPatch) => void;
  readonly reportCompatibility: (entry: CompatibilityInput) => void;
}

/** Extension 为一个 Platform 提供横向能力落地方式的桥接契约。 */
export interface ExtensionPlatformAdapter<TBuilt = unknown> {
  readonly extensionApiVersion: typeof LIFECYCLE_API_VERSION;
  readonly platform: PlatformId;
  readonly platformApiVersion: typeof LIFECYCLE_API_VERSION;
  /** 把 Extension Built State 以 add-only 方式应用到当前 Platform Draft。 */
  apply(context: PlatformAdapterContext, built: Readonly<TBuilt>): Awaitable<void>;
}

/** definePlatform 接受的不带私有品牌的第三方 Platform 定义。 */
export interface PlatformDefinition {
  readonly id: string | PlatformId;
  readonly apiVersion: typeof LIFECYCLE_API_VERSION;
  readonly deliveryType: PlatformDeliveryType;
  readonly strict?: boolean;
  readonly options?: JsonObject;
  readonly validateComponentFields?: (context: PlatformComponentValidationContext) => Awaitable<void>;
  readonly configResolved?: (context: ConfigResolvedContext) => Awaitable<void>;
  readonly buildStart?: (context: BuildStartContext) => Awaitable<void>;
  readonly prepare: (context: PlatformPrepareContext) => Awaitable<PlatformDraftInput>;
  readonly generateBundle: (context: PlatformGenerateContext) => Awaitable<DeliveryUnitInput>;
  readonly validateBundle: (context: PlatformValidateContext) => Awaitable<void>;
  readonly generateDistributions?: (
    context: PlatformDistributionContext,
    primaryUnits: readonly DeliveryUnit[],
  ) => Awaitable<readonly DeliveryUnitInput[]>;
  readonly buildEnd?: (context: BuildEndContext) => Awaitable<void>;
}

/** 只能由 definePlatform 生成并由 Core 接受的名义化 Platform 实例。 */
export interface AcpluginPlatform extends Omit<PlatformDefinition, 'id'> {
  readonly id: PlatformId;
  readonly [platformBrand]: true;
}

/** defineExtension 接受的不带私有品牌的第三方横向扩展定义。 */
export interface ExtensionDefinition<TDiscovered = unknown, TBuilt = unknown> {
  readonly name: string;
  readonly apiVersion: typeof LIFECYCLE_API_VERSION;
  /** 观察完整配置身份但不读取源码或产物。 */
  configResolved?(context: ConfigResolvedContext): Awaitable<void>;
  /** 在资源发现前初始化当前 Extension 的隔离工作目录。 */
  buildStart?(context: BuildStartContext): Awaitable<void>;
  /** 扫描当前 Extension 独占的作者格式并返回阶段状态。 */
  discover?(context: ExtensionDiscoverContext): Awaitable<TDiscovered>;
  /** 对发现状态和规范 PluginProject 执行只读验证。 */
  validate?(context: ExtensionValidateContext, discovered: Readonly<TDiscovered>): Awaitable<void>;
  /** 在独占临时目录生成平台中立 Built State。 */
  build?(context: ExtensionBuildContext, discovered: Readonly<TDiscovered>): Awaitable<TBuilt>;
  readonly adapters: readonly ExtensionPlatformAdapter<TBuilt>[];
  /** 无论成功或失败都执行的最终逆序清理 Hook。 */
  buildEnd?(context: BuildEndContext): Awaitable<void>;
}

/** 只能由 defineExtension 生成并由 Core 接受的名义化 Extension 实例。 */
export interface AcpluginExtension<TDiscovered = unknown, TBuilt = unknown>
  extends ExtensionDefinition<TDiscovered, TBuilt> {
  readonly [extensionBrand]: true;
}

/**
 * 把经过格式校验的开放字符串转换为 PlatformId 品牌。
 *
 * @param value Platform 定义或 Adapter 引用提供的平台标识。
 * @returns 仅在当前模块内完成品牌转换的 PlatformId。
 */
function toPlatformId(value: string): PlatformId {
  if (!PLATFORM_ID_PATTERN.test(value))
    throw new TypeError(`Platform id "${value}" must use lowercase kebab-case.`);
  return value as PlatformId;
}

/**
 * 验证未知值是否为当前 Core 工厂创建且 API 版本兼容的 Platform。
 *
 * @param value 配置解析阶段收到的未知候选。
 * @returns 品牌、版本和基础字段都有效时返回 true。
 */
export function isAcpluginPlatform(value: unknown): value is AcpluginPlatform {
  if (typeof value !== 'object' || value === null)
    return false;
  /** 读取私有 Symbol 和公共字段所需的安全索引视图。 */
  const candidate = value as Record<PropertyKey, unknown>;
  return candidate[platformBrand] === true
    && candidate.apiVersion === LIFECYCLE_API_VERSION
    && typeof candidate.id === 'string'
    && PLATFORM_ID_PATTERN.test(candidate.id)
    && (candidate.deliveryType === 'plugin' || candidate.deliveryType === 'workspace' || candidate.deliveryType === 'package')
    && (candidate.strict === undefined || typeof candidate.strict === 'boolean')
    && isJsonObject(candidate.options)
    && (candidate.validateComponentFields === undefined || typeof candidate.validateComponentFields === 'function')
    && typeof candidate.prepare === 'function'
    && typeof candidate.generateBundle === 'function'
    && typeof candidate.validateBundle === 'function';
}

/**
 * 递归复制并冻结 Platform 专属 JSON 配置，避免配置文件随后修改生命周期输入。
 *
 * @param value 尚未越过 Core 信任边界的配置值。
 * @param seen 当前递归路径上的对象，用于拒绝循环引用。
 * @returns 只包含 JSON 值的不可变副本。
 */
function normalizeJsonValue(value: unknown, seen: Set<object>): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean')
    return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value))
      throw new TypeError('Platform options must contain only finite JSON numbers.');
    return value;
  }
  if (typeof value !== 'object')
    throw new TypeError('Platform options must contain only JSON values.');
  if (seen.has(value))
    throw new TypeError('Platform options must not contain circular references.');
  seen.add(value);
  if (Array.isArray(value)) {
    /** 数组元素保持声明顺序，但每一项都转换为独立不可变副本。 */
    const result = Object.freeze(value.map(item => normalizeJsonValue(item, seen)));
    seen.delete(value);
    return result;
  }
  /** 只接受普通对象，避免类实例通过 getter 或原型行为进入生命周期。 */
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null)
    throw new TypeError('Platform options must use plain JSON objects.');
  /** 对象字段保持配置作者的值语义，Core 只提供冻结快照。 */
  const result: Record<string, JsonValue> = {};
  for (const [key, child] of Object.entries(value))
    result[key] = normalizeJsonValue(child, seen);
  seen.delete(value);
  return Object.freeze(result);
}

/**
 * 判断未知值能否作为 Platform options 根对象。
 *
 * @param value Platform 实例携带的未知配置。
 * @returns 值能够安全规范化为 JSON 对象时返回 true。
 */
function isJsonObject(value: unknown): boolean {
  if (value === undefined)
    return true;
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return false;
  try {
    normalizeJsonValue(value, new Set<object>());
    return true;
  } catch {
    return false;
  }
}

/**
 * 规范化 Platform options 根节点，并明确拒绝数组等非对象 JSON 值。
 *
 * @param value Platform 定义声明的可选配置。
 * @returns 深度冻结的普通 JSON 对象。
 */
function normalizePlatformOptions(value: unknown): JsonObject {
  if (value === undefined)
    return Object.freeze({});
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new TypeError('Platform options must use a JSON object.');
  return normalizeJsonValue(value, new Set<object>()) as JsonObject;
}

/**
 * 为第三方 Platform 注入不可伪造品牌，并在配置进入生命周期前校验版本和 ID。
 *
 * @param definition 不带品牌的 Platform 生命周期实现。
 * @returns 冻结且可由 Core 品牌校验的 Platform 实例。
 */
export function definePlatform<const TDefinition extends PlatformDefinition>(
  definition: TDefinition,
): Readonly<TDefinition> & AcpluginPlatform {
  if (definition.apiVersion !== LIFECYCLE_API_VERSION)
    throw new TypeError(`Unsupported Platform API version "${String(definition.apiVersion)}".`);
  /** 使用副本避免给配置作者持有的原对象追加内部状态。 */
  const platform = {
    ...definition,
    id: toPlatformId(definition.id),
    options: normalizePlatformOptions(definition.options),
  };
  Object.defineProperty(platform, platformBrand, { value: true, enumerable: false });
  return Object.freeze(platform) as Readonly<TDefinition> & AcpluginPlatform;
}

/**
 * 验证未知值是否为当前 Core 工厂创建且 API 版本兼容的 Extension。
 *
 * @param value 配置解析阶段收到的未知候选。
 * @returns 品牌、版本、名称和 Adapter 列表有效时返回 true。
 */
export function isAcpluginExtension(value: unknown): value is AcpluginExtension {
  if (typeof value !== 'object' || value === null)
    return false;
  /** 读取私有 Symbol 和公共字段所需的安全索引视图。 */
  const candidate = value as Record<PropertyKey, unknown>;
  return candidate[extensionBrand] === true
    && candidate.apiVersion === LIFECYCLE_API_VERSION
    && typeof candidate.name === 'string'
    && candidate.name.length > 0
    && Array.isArray(candidate.adapters);
}

/**
 * 验证并冻结 Extension 的一个 Platform Adapter。
 *
 * @param adapter Extension 作者提供的 Adapter 定义。
 * @returns 使用规范 PlatformId 且不可变的 Adapter 副本。
 */
function normalizeAdapter<TBuilt>(adapter: ExtensionPlatformAdapter<TBuilt>): ExtensionPlatformAdapter<TBuilt> {
  if (adapter.extensionApiVersion !== LIFECYCLE_API_VERSION)
    throw new TypeError(`Unsupported Extension Adapter API version "${String(adapter.extensionApiVersion)}".`);
  if (adapter.platformApiVersion !== LIFECYCLE_API_VERSION)
    throw new TypeError(`Unsupported Platform Adapter API version "${String(adapter.platformApiVersion)}".`);
  if (typeof adapter.apply !== 'function')
    throw new TypeError('Extension Platform Adapter must provide apply().');
  return Object.freeze({ ...adapter, platform: toPlatformId(adapter.platform) });
}

/**
 * 为第三方 Extension 注入不可伪造品牌，并拒绝版本错误或重复 Platform Adapter。
 *
 * @param definition 不带品牌的 Extension 生命周期与 Adapter 定义。
 * @returns 冻结且可由 Core 品牌校验的 Extension 实例。
 */
export function defineExtension<TDiscovered = unknown, TBuilt = unknown>(
  definition: ExtensionDefinition<TDiscovered, TBuilt>,
): AcpluginExtension<TDiscovered, TBuilt> {
  if (definition.apiVersion !== LIFECYCLE_API_VERSION)
    throw new TypeError(`Unsupported Extension API version "${String(definition.apiVersion)}".`);
  if (definition.name.trim().length === 0)
    throw new TypeError('Extension name must not be empty.');
  /** 冻结后的 Adapter 副本，确保生命周期中平台映射不会变化。 */
  const adapters = definition.adapters.map(normalizeAdapter<TBuilt>);
  /** 用于拒绝同一 Extension 内部两个 Adapter 隐式覆盖同一 Platform。 */
  const platforms = new Set<string>();
  for (const adapter of adapters) {
    if (platforms.has(adapter.platform))
      throw new TypeError(`Extension "${definition.name}" has duplicate Adapter for Platform "${adapter.platform}".`);
    platforms.add(adapter.platform);
  }
  /** 使用副本隔离配置作者持有的原始定义和 adapters 数组。 */
  const extension = { ...definition, adapters: Object.freeze(adapters) };
  Object.defineProperty(extension, extensionBrand, { value: true, enumerable: false });
  return Object.freeze(extension) as AcpluginExtension<TDiscovered, TBuilt>;
}
