import {
  LIFECYCLE_API_VERSION,
  type Awaitable,
  type DocumentFieldPath,
  type JsonObject,
  type JsonValue,
} from './common.js';
import type {
  BuildMode,
  ConfigCommand,
  ResolvedConfigSummary,
} from './config.js';
import type {
  CanonicalProject,
  PlatformComponentValidationContext,
} from './components.js';
import type { CompilerService } from './compiler.js';
import type {
  CreatePackageContext,
  DistributionContext,
  DistributionPackageInput,
  FinalizePackageContext,
  PackageAssetInput,
  PlatformBasePackageSnapshot,
  PlatformPackageInput,
  PrimaryPackageInput,
  ValidatePackageContext,
} from './packages.js';
import type {
  AssetService,
  DiagnosticService,
  ExecutionService,
  ModuleService,
  SourceDirectoryRef,
  SourceService,
} from './services.js';

/** Platform 声明的稳定 Plugin-local Node Runtime 能力。 */
export type NodeRuntimeCapability = Readonly<{
  target: 'node20';
  format: 'esm';
  root: 'plugin';
}>;

/** Platform 供 Framework 和 Extension 协商的只读能力数据。 */
export type PlatformCapabilities = Readonly<{
  nodeRuntime?: NodeRuntimeCapability;
  readonly [capability: string]: JsonValue | NodeRuntimeCapability | undefined;
}>;

/** Platform 主交付的安装形态。 */
export type PlatformDeliveryType = 'plugin' | 'workspace' | 'package';

/** 仅用于 TypeScript 名义类型的 Platform 品牌，不参与运行时授权。 */
declare const platformDefinitionTypeBrand: unique symbol;

/** 仅用于 TypeScript 名义类型的 Extension 品牌，不参与运行时授权。 */
declare const extensionDefinitionTypeBrand: unique symbol;

/**
 * 仅用于 TypeScript 名义类型的 Platform Component 来源品牌。
 *
 * Core 在 merge 时签发其对象 identity；后续 finalization 专属服务会以该 identity
 * 作为运行时授权边界。调用方不能以同形普通对象替代它。
 */
declare const packageComponentOriginTypeBrand: unique symbol;

/** 作者配置中可安装的 Platform 定义。 */
export interface PlatformDefinition<
  O extends JsonObject = JsonObject,
  TComponent extends JsonObject = never,
> {
  readonly id: string;
  readonly apiVersion: typeof LIFECYCLE_API_VERSION;
  readonly deliveryType: PlatformDeliveryType;
  readonly strict?: boolean;
  readonly options?: O;
  readonly capabilities?: PlatformCapabilities;
  /** 为当前 BuildSession 创建隔离的平台生命周期状态。 */
  createSession(context: PlatformSetupContext<O>): Awaitable<PlatformSession<TComponent>>;
}

/** 经过工厂校验、复制、品牌化和冻结的 Platform。 */
export interface AcpluginPlatform<
  O extends JsonObject = JsonObject,
  TComponent extends JsonObject = never,
> extends PlatformDefinition<O, TComponent> {
  readonly [platformDefinitionTypeBrand]: true;
}

/** Extension 验证后声明的兼容性覆盖主题。 */
export interface ExtensionSubject {
  readonly subject: string;
  readonly capabilities: readonly string[];
}

/** Extension validate 阶段的状态与覆盖声明。 */
export interface ExtensionValidationOutput<V> {
  readonly state: Readonly<V>;
  readonly subjects: readonly ExtensionSubject[];
}

/** Extension build 阶段的不可变 Built State。 */
export interface ExtensionBuildOutput<B> {
  readonly state: Readonly<B>;
}

/** 作者配置中可安装的 Extension 定义。 */
export interface ExtensionDefinition<
  O extends JsonObject = JsonObject,
  D = unknown,
  V = D,
  B = V,
> {
  readonly id: string;
  readonly apiVersion: typeof LIFECYCLE_API_VERSION;
  readonly options?: O;
  readonly resourceRoots: readonly string[];
  /** 为当前 BuildSession 创建隔离的 Extension 生命周期状态。 */
  createSession(context: ExtensionSetupContext<O>): Awaitable<ExtensionSession<D, V, B>>;
}

/** 经过工厂校验、复制、品牌化和冻结的 Extension。 */
export interface AcpluginExtension<
  O extends JsonObject = JsonObject,
  D = unknown,
  V = D,
  B = V,
> extends ExtensionDefinition<O, D, V, B> {
  readonly [extensionDefinitionTypeBrand]: true;
}

/** Platform 对其他集成公开的稳定身份。 */
export interface PlatformIntegrationDescription {
  readonly kind: 'platform';
  readonly id: string;
  readonly apiVersion: typeof LIFECYCLE_API_VERSION;
  readonly options?: Readonly<JsonObject>;
  readonly capabilities?: Readonly<PlatformCapabilities>;
}

/** Extension 对其他集成公开的稳定身份。 */
export interface ExtensionIntegrationDescription {
  readonly kind: 'extension';
  readonly id: string;
  readonly apiVersion: typeof LIFECYCLE_API_VERSION;
  readonly options?: Readonly<JsonObject>;
  readonly resourceRoots: readonly string[];
}

/** 集成只能观察的结构化身份联合类型。 */
export type IntegrationDescription = PlatformIntegrationDescription | ExtensionIntegrationDescription;

/** Platform Session 创建上下文。 */
export interface PlatformSetupContext<O extends JsonObject = JsonObject> {
  readonly command: ConfigCommand;
  readonly mode: BuildMode;
  readonly options: Readonly<O>;
  readonly config: ResolvedConfigSummary;
  readonly integrations: readonly IntegrationDescription[];
}

/** Extension Session 创建上下文。 */
export type ExtensionSetupContext<O extends JsonObject = JsonObject> = PlatformSetupContext<O>;

/** Extension discover 阶段的受限上下文。 */
export interface ExtensionDiscoverContext {
  readonly command: ConfigCommand;
  readonly mode: BuildMode;
  readonly roots: Readonly<Record<string, SourceDirectoryRef>>;
  readonly sources: SourceService;
  readonly modules: ModuleService;
  readonly diagnostics: DiagnosticService;
}

/** Extension validate 阶段的规范工程上下文。 */
export interface ExtensionValidateContext {
  readonly command: ConfigCommand;
  readonly mode: BuildMode;
  readonly project: CanonicalProject;
  readonly diagnostics: DiagnosticService;
}

/** Extension build 阶段的受管能力上下文。 */
export interface ExtensionBuildContext extends ExtensionValidateContext {
  readonly compiler: CompilerService;
  readonly assets: AssetService;
  readonly execution: ExecutionService;
}

/** 集成清理阶段看到的脱敏结果。 */
export interface IntegrationCloseContext {
  readonly outcome: 'success' | 'failed' | 'aborted';
  readonly committed: boolean;
  readonly failure?: { readonly code: string; readonly phase: string; readonly message: string };
}

/** Platform BuildSession 私有生命周期。 */
export interface PlatformSession<TComponent extends JsonObject = never> {
  /** 校验一个 canonical Component 的平台专属字段。 */
  validateComponent?(context: PlatformComponentValidationContext): Awaitable<void>;
  /** 从 canonical project 创建 Platform base Package。 */
  createPackage(context: CreatePackageContext): Awaitable<PlatformPackageInput>;
  /** 从集中合并的 snapshot 确定主 Package。 */
  finalizePackage(context: FinalizePackageContext<TComponent>): Awaitable<PrimaryPackageInput>;
  /** 校验 Core 临时物化的完整 Package candidate。 */
  validatePackage(context: ValidatePackageContext): Awaitable<void>;
  /** 从已验证主 Package 创建可选 Distribution。 */
  createDistributions?(context: DistributionContext): Awaitable<readonly DistributionPackageInput[]>;
  /** 在成功、失败或中止后释放当前 Session 状态。 */
  close?(context: IntegrationCloseContext): Awaitable<void>;
}

/** Extension 对一个 Platform 的无序 add-only Contributor。 */
export interface PlatformContributor<B, TComponent extends JsonObject = never> {
  readonly platform: string;
  readonly platformApiVersion: typeof LIFECYCLE_API_VERSION;
  /** 对只读 base Package 返回无序 add-only Contribution。 */
  contribute(context: ContributionContext, built: Readonly<B>): Awaitable<PackageContribution<TComponent>>;
}

/** Extension 向 Platform 提交的一条不透明 JSON Component payload。 */
export interface PackageComponentInput<TComponent extends JsonObject = never> {
  /** 必须精确对应当前 Extension validate() 已声明的 subject。 */
  readonly subject: string;
  /** 仅由目标 Platform 理解的严格 JSON object。 */
  readonly value: TComponent;
}

/**
 * Core 签发的 Component provenance identity。
 *
 * owner/subject 仅用于审计和稳定诊断；后续消费必须接受 Core 当前 merge 暴露的原始
 * 对象 identity，而不能以同形值伪造来源。
 */
export interface PackageComponentOrigin {
  readonly owner: string;
  readonly subject: string;
  readonly [packageComponentOriginTypeBrand]: true;
}

/** 已合并且可供当前 Platform finalization 消费的 Component payload。 */
export interface ContributedPackageComponent<TComponent extends JsonObject = JsonObject> {
  readonly value: Readonly<TComponent>;
  readonly origin: PackageComponentOrigin;
}

/** Extension 对一个 Document extension point 的字段贡献。 */
export interface DocumentFieldContribution {
  readonly document: string;
  readonly path: DocumentFieldPath;
  readonly value: JsonValue;
}

/** Extension Contributor 的集中合并输入。 */
export interface PackageContribution<TComponent extends JsonObject = never> {
  /** Platform-owned Component 的不透明输入；Core 不读取 value 的业务字段。 */
  readonly components?: readonly PackageComponentInput<TComponent>[];
  readonly documentFields?: readonly DocumentFieldContribution[];
  readonly assets?: readonly PackageAssetInput[];
  readonly compatibility: readonly CompatibilityInput[];
}

/** Contributor 只能观察 Platform base snapshot 的上下文。 */
export interface ContributionContext {
  readonly command: ConfigCommand;
  readonly mode: BuildMode;
  readonly platform: PlatformIntegrationDescription;
  readonly project: CanonicalProject;
  readonly base: PlatformBasePackageSnapshot;
  readonly assets: AssetService;
  readonly diagnostics: DiagnosticService;
}

/** Extension BuildSession 私有生命周期。 */
export interface ExtensionSession<D, V, B> {
  /** 从 Extension 独占来源根发现作者资源。 */
  discover(context: ExtensionDiscoverContext): Awaitable<D | undefined>;
  /** 对发现状态和 canonical project 执行验证。 */
  validate(context: ExtensionValidateContext, discovered: Readonly<D>): Awaitable<ExtensionValidationOutput<V>>;
  /** 通过 Core Host 把验证状态构建为跨 Platform Built State。 */
  build(context: ExtensionBuildContext, validated: Readonly<V>): Awaitable<ExtensionBuildOutput<B>>;
  /**
   * Extension 边界接受异构 Platform payload；具体 Contributor 在其定义处保留
   * Platform 自己的 union 类型，Core 在配置边界擦除为 JsonObject。
   */
  readonly contributors: readonly PlatformContributor<B, JsonObject>[];
  /** 在成功、失败或中止后释放当前 Session 状态。 */
  close?(context: IntegrationCloseContext): Awaitable<void>;
}

/** Platform 或 Contributor 返回的兼容性结论。 */
export interface CompatibilityInput {
  readonly subject: string;
  readonly capability: string;
  readonly level: CompatibilityLevel;
  readonly transformation?: string;
  readonly reason: string;
  readonly causes?: readonly string[];
}

/** 兼容性支持级别。 */
export type CompatibilityLevel = 'native' | 'transform' | 'degraded' | 'unsupported';

/** 元数据在目标 Package 中的最终去向。 */
export type MetadataDisposition = 'emitted' | 'omitted';

/** Platform 返回的单个元数据处理结论。 */
export interface MetadataDispositionInput {
  readonly field: string;
  readonly disposition: MetadataDisposition;
  readonly output?: string;
  readonly reason: string;
}
