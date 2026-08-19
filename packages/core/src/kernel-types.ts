import type {
  EngineInputOptions,
  EngineOutputOptions,
  EnginePlugin,
} from './compiler/engine-loader.js';

/** Platform 与 Extension 共同使用且在本轮重写中保持不变的生命周期 API 版本。 */
export const LIFECYCLE_API_VERSION = '1' as const;

/** 同步值或 PromiseLike 值。 */
export type Awaitable<T> = T | PromiseLike<T>;

/** JSON 标量。 */
export type JsonPrimitive = string | number | boolean | null;

/** 可由 Core 复制、验证并冻结的 JSON 对象。 */
export interface JsonObject {
  readonly [key: string]: JsonValue;
}

/** 可由 Core 确定性处理的 JSON 值。 */
export type JsonValue = JsonPrimitive | readonly JsonValue[] | JsonObject;

/** Document 中不可歧义的非空字段路径。 */
export type DocumentFieldPath = readonly [string, ...string[]];

/** 配置与 BuildSession 支持的命令。 */
export type ConfigCommand = 'dev' | 'validate' | 'inspect' | 'build';

/** 构建执行模式。 */
export type BuildMode = 'development' | 'production';

/** 函数式配置唯一可观察的执行环境。 */
export interface ConfigEnvironment {
  readonly command: ConfigCommand;
  readonly mode: BuildMode;
}

/** Plugin 作者元数据。 */
export interface PluginAuthor {
  readonly name: string;
  readonly email?: string;
  readonly url?: string;
}

/** 规范化后的 Plugin 元数据。 */
export interface PluginMetadata {
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly displayName?: string;
  readonly author?: PluginAuthor;
  readonly homepage?: string;
  readonly repository?: string;
  readonly license?: string;
  readonly keywords: readonly string[];
}

/** Public 目录中的一条显式来源映射。 */
export interface PublicCopyRule {
  readonly from: string;
  readonly to: string;
}

/** Public 资源的关闭、简写或精确映射配置。 */
export type PublicConfig = false | string | {
  readonly dir?: string;
  readonly copy?: readonly PublicCopyRule[];
};

/** Node Runtime 入口的执行意图。 */
export type NodeRuntimeEntryKind = 'executable' | 'module';

/** 作者显式配置的 Node Runtime 入口。 */
export interface NodeRuntimeEntryInput {
  readonly entry: string;
  readonly kind?: NodeRuntimeEntryKind;
}

/** portable-node 允许作者调整的解析参数。 */
type PortableReadonlyField<T> = T extends readonly (infer E)[] ? readonly E[] : T;

/** 从精确 Engine 类型派生只读 JSON 参数子集。 */
type PortableOptionSubset<T, K extends keyof T> = Readonly<{
  [P in K]?: PortableReadonlyField<NonNullable<T[P]>>;
}>;

/** portable-node 允许作者调整的解析参数。 */
export type PortableNodeResolveOptions = PortableOptionSubset<
  NonNullable<EngineInputOptions['resolve']>,
  'conditionNames' | 'extensions' | 'mainFields' | 'mainFiles'
>;

/** portable-node 允许作者调整的转换参数。 */
export type PortableNodeTransformOptions = PortableOptionSubset<
  NonNullable<EngineInputOptions['transform']>,
  'define' | 'dropLabels'
> & {
  readonly jsx?: false | 'react' | 'react-jsx' | 'preserve';
};

/** 固定 Node 20 ESM contract 内可复用的纯 JSON 编译参数。 */
export interface PortableNodeCompileOptions {
  readonly resolve?: PortableNodeResolveOptions;
  readonly transform?: PortableNodeTransformOptions;
  readonly treeshake?: Extract<EngineInputOptions['treeshake'], boolean>;
}

/** 内建 Node Runtime Resource 的作者配置。 */
export interface NodeRuntimeConfig {
  readonly target?: 'node20';
  readonly entries?: Readonly<Record<string, NodeRuntimeEntryInput>>;
  readonly compile?: PortableNodeCompileOptions;
}

/** 构建输出和全局兼容性策略。 */
export interface BuildConfig {
  readonly outDir?: string;
  readonly strict?: boolean;
}

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

/** 作者配置中可安装的 Platform 定义。 */
export interface PlatformDefinition<O extends JsonObject = JsonObject> {
  readonly id: string;
  readonly apiVersion: typeof LIFECYCLE_API_VERSION;
  readonly deliveryType: PlatformDeliveryType;
  readonly strict?: boolean;
  readonly options?: O;
  readonly capabilities?: PlatformCapabilities;
  /** 为当前 BuildSession 创建隔离的平台生命周期状态。 */
  createSession(context: PlatformSetupContext<O>): Awaitable<PlatformSession>;
}

/** 经过工厂校验、复制、品牌化和冻结的 Platform。 */
export interface AcpluginPlatform<O extends JsonObject = JsonObject> extends PlatformDefinition<O> {
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

/** acplugin.config.ts 的最终作者配置。 */
export interface UserConfig {
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly displayName?: string;
  readonly author?: PluginAuthor;
  readonly homepage?: string;
  readonly repository?: string;
  readonly license?: string;
  readonly keywords?: readonly string[];
  readonly srcDir?: string;
  readonly public?: PublicConfig;
  readonly runtime?: false | NodeRuntimeConfig;
  readonly platforms: readonly AcpluginPlatform[];
  readonly extensions?: readonly AcpluginExtension[];
  readonly build?: BuildConfig;
}

/** 配置文件允许导出的静态对象或函数。 */
export type UserConfigExport = UserConfig | ((environment: Readonly<ConfigEnvironment>) => Awaitable<UserConfig>);

/** 不包含工程路径的已解析配置摘要。 */
export interface ResolvedConfigSummary {
  readonly metadata: Readonly<PluginMetadata>;
  readonly command: ConfigCommand;
  readonly mode: BuildMode;
  readonly strict: boolean;
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

/** 安全的工程相对来源位置。 */
export interface SourceLocation {
  readonly path: string;
  readonly line?: number;
  readonly column?: number;
}

/** 生命周期可以提交的稳定诊断。 */
export interface DiagnosticInput {
  readonly code: string;
  readonly severity: 'warning' | 'error';
  readonly message: string;
  readonly location?: SourceLocation;
  readonly fieldPath?: readonly (string | number)[];
  readonly hint?: string;
}

/** 绑定 owner 和 phase 的诊断服务。 */
export interface DiagnosticService {
  /** 向当前 owner 和 phase 提交一条结构化诊断。 */
  report(input: DiagnosticInput): void;
}

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

/** Core 签发的源码目录能力；运行时授权依赖 Session 对象身份。 */
declare const sourceDirectoryTypeBrand: unique symbol;

/** Core 签发的源码文件能力；运行时授权依赖 Session 对象身份。 */
declare const sourceFileTypeBrand: unique symbol;

/** Source Registry 签发的来源 Asset 类型品牌。 */
declare const sourceAssetTypeBrand: unique symbol;

/** Compiler Host 签发的生成 Asset 类型品牌。 */
declare const generatedAssetTypeBrand: unique symbol;

/** Asset Service 签发的内存字节 Asset 类型品牌。 */
declare const bytesAssetTypeBrand: unique symbol;

/** Core 签发的源码目录能力；运行时授权依赖 Session 对象身份。 */
export interface SourceDirectoryRef {
  readonly kind: 'source-directory';
  readonly path: string;
  readonly [sourceDirectoryTypeBrand]: true;
}

/** Core 签发的源码文件能力；运行时授权依赖 Session 对象身份。 */
export interface SourceFileRef {
  readonly kind: 'source-file';
  readonly path: string;
  readonly [sourceFileTypeBrand]: true;
}

/** Source Service 返回的已验证目录项。 */
export type SourceEntry = {
  readonly type: 'file';
  readonly name: string;
  readonly path: string;
  readonly file: SourceFileRef;
} | {
  readonly type: 'directory';
  readonly name: string;
  readonly path: string;
  readonly directory: SourceDirectoryRef;
};

/** owner-scoped 源码读取能力。 */
export interface SourceService {
  /** 枚举一个已授权来源目录。 */
  list(directory: SourceDirectoryRef, options?: { readonly recursive?: boolean }): Promise<readonly SourceEntry[]>;
  /** 从已授权目录签发后代文件 ref。 */
  file(directory: SourceDirectoryRef, relativePath: string): Promise<SourceFileRef>;
  /** 从已授权目录签发后代目录 ref。 */
  directory(directory: SourceDirectoryRef, relativePath: string): Promise<SourceDirectoryRef>;
  /** 在读取上限内复制来源文件字节。 */
  read(file: SourceFileRef, options?: { readonly maxBytes?: number }): Promise<Uint8Array>;
  /** 在读取上限内以 UTF-8 解码来源文件。 */
  readText(file: SourceFileRef, options?: { readonly maxBytes?: number }): Promise<string>;
}

/** 可信结构化 ESM 作者模块的加载服务。 */
export interface ModuleService {
  /** 执行受管 ESM 图并返回其 default export。 */
  loadDefault<T = unknown>(request: { readonly id: string; readonly entry: SourceFileRef }): Promise<T>;
}

/** Source Registry 签发的来源 Asset。 */
export interface SourceAssetRef {
  readonly kind: 'source-asset';
  readonly id: string;
  readonly [sourceAssetTypeBrand]: true;
}

/** Compiler Host 签发的生成 Asset。 */
export interface GeneratedAssetRef {
  readonly kind: 'generated-asset';
  readonly id: string;
  readonly [generatedAssetTypeBrand]: true;
}

/** Compiler Host 向 Asset Registry 提交的结构化生成来源。 */
export interface CompileAssetOriginInput {
  readonly job: string;
  readonly output: string;
  readonly profile: CompileProfile;
  readonly kind: CompileOutputFile['type'];
  readonly inputs: readonly string[];
}

/** Asset Service 从内存字节签发的 Asset。 */
export interface BytesAssetRef {
  readonly kind: 'bytes-asset';
  readonly id: string;
  readonly [bytesAssetTypeBrand]: true;
}

/** 所有受管 Asset 引用。 */
export type AssetRef = SourceAssetRef | GeneratedAssetRef | BytesAssetRef;

/** 受管 Asset 支持的文件权限。 */
export type AssetMode = 0o644 | 0o755;

/** Bytes Asset 的稳定生成来源。 */
export interface GeneratedBytesOriginInput {
  readonly operation: string;
  readonly subjects?: readonly string[];
}

/** owner-scoped Asset 创建与受限读取服务。 */
export interface AssetService {
  /** 从已授权来源文件创建保留来源身份的 Asset。 */
  fromSource(source: SourceFileRef, options?: { readonly mode?: AssetMode }): Promise<SourceAssetRef>;
  /** 从复制后的内存字节创建带结构化来源的 Asset。 */
  fromBytes(input: { readonly bytes: Uint8Array | string; readonly mode?: AssetMode; readonly origin: GeneratedBytesOriginInput }): Promise<BytesAssetRef>;
  /** 在 owner grant 和读取上限内复制 Asset 字节。 */
  read(asset: AssetRef, options?: { readonly maxBytes?: number }): Promise<Uint8Array>;
}

/** 规范 Component 的依赖引用。 */
export interface ComponentRequires {
  readonly skills: readonly string[];
  readonly agents: readonly string[];
}

/** Component 正文在安全工程相对路径中的位置。 */
export interface ComponentLocation {
  readonly path: string;
  readonly bodyLine: number;
}

/** 规范 Command。 */
export interface CommandComponent {
  readonly kind: 'command';
  readonly id: string;
  readonly description: string;
  readonly argumentHint?: string;
  readonly body: string;
  readonly location: ComponentLocation;
  readonly requires: ComponentRequires;
  readonly platforms: Readonly<Record<string, Readonly<JsonObject>>>;
}

/** 规范 Skill。 */
export interface SkillComponent {
  readonly kind: 'skill';
  readonly id: string;
  readonly description: string;
  readonly invocation: { readonly user: boolean; readonly model: boolean };
  readonly body: string;
  readonly location: ComponentLocation;
  readonly requires: ComponentRequires;
  readonly platforms: Readonly<Record<string, Readonly<JsonObject>>>;
  readonly auxiliaryFiles: readonly { readonly path: string; readonly asset: SourceAssetRef }[];
}

/** Agent 需要的平台中立工具能力。 */
export type AgentCapability = 'filesystem:read' | 'filesystem:write' | 'search' | 'shell' | 'network' | 'delegate';

/** Agent 的平台中立模型级别。 */
export type AgentModel = 'inherit' | 'fast' | 'capable';

/** 规范 Agent。 */
export interface AgentComponent {
  readonly kind: 'agent';
  readonly id: string;
  readonly description: string;
  readonly model: AgentModel;
  readonly capabilities: readonly AgentCapability[];
  readonly body: string;
  readonly location: ComponentLocation;
  readonly requires: ComponentRequires;
  readonly platforms: Readonly<Record<string, Readonly<JsonObject>>>;
}

/** Public Provider 发现的资源。 */
export interface PublicResourceFile {
  readonly path: string;
  readonly asset: SourceAssetRef;
}

/** 内建 Runtime Provider 发现的规范入口集合。 */
export interface NodeRuntimeResource {
  readonly target: 'node20';
  readonly entries: readonly { readonly id: string; readonly kind: NodeRuntimeEntryKind; readonly source: SourceFileRef }[];
  readonly compile?: PortableNodeCompileOptions;
}

/** Scanner 完成验证后的规范工程图。 */
export interface CanonicalProject {
  readonly metadata: PluginMetadata;
  readonly commands: readonly CommandComponent[];
  readonly skills: readonly SkillComponent[];
  readonly agents: readonly AgentComponent[];
  readonly publicFiles: readonly PublicResourceFile[];
  readonly runtime?: NodeRuntimeResource;
}

/** Platform 的 Component 专属字段验证上下文。 */
export interface PlatformComponentValidationContext {
  readonly project: CanonicalProject;
  readonly component: CommandComponent | SkillComponent | AgentComponent;
  readonly diagnostics: DiagnosticService;
}

/** Compiler Job 的来源或虚拟入口。 */
export type CompileEntry = {
  readonly type: 'source';
  readonly source: SourceFileRef;
  readonly mode?: AssetMode;
} | {
  readonly type: 'virtual';
  readonly code: string;
  readonly resolveFrom: SourceDirectoryRef;
  readonly mode?: AssetMode;
};

/** Core 支持的两个编译 Profile。 */
export type CompileProfile = 'portable-node' | 'managed-rolldown';

/** managed Profile 禁止接受但不执行的写入和 Watch Plugin Hook。 */
export type ForbiddenManagedPluginHook = 'writeBundle' | 'watchChange' | 'closeWatcher';

/** managed Profile 可调用的 Rolldown Plugin。 */
export type ManagedRolldownPlugin = Omit<EnginePlugin, ForbiddenManagedPluginHook>;

/** Rolldown 风格的递归 Plugin option。 */
export type ManagedRolldownPluginOption = ManagedRolldownPlugin
  | { readonly name: string }
  | false
  | null
  | undefined
  | PromiseLike<ManagedRolldownPluginOption>
  | readonly ManagedRolldownPluginOption[];

/** Core 从 managed input options 中接管的字段。 */
type CoreOwnedManagedInputOption = 'input' | 'cwd' | 'plugins' | 'logLevel' | 'onwarn' | 'watch' | 'devtools' | 'output' | 'tsconfig';

/** trusted integration 可使用的 Rolldown input 能力。 */
export type ManagedRolldownInputOptions = Omit<EngineInputOptions, CoreOwnedManagedInputOption> & {
  readonly plugins?: ManagedRolldownPluginOption;
  readonly tsconfig?: false | SourceFileRef;
};

/** trusted integration 可使用的 Rolldown output 能力。 */
export type ManagedRolldownOutputOptions = Omit<EngineOutputOptions, 'dir' | 'file' | 'plugins'> & {
  readonly plugins?: ManagedRolldownPluginOption;
};

/** managed Profile 的输出与审计策略。 */
export interface ManagedRolldownCompileOptions {
  readonly inputOptions?: ManagedRolldownInputOptions;
  readonly outputs: readonly { readonly id: string; readonly options: ManagedRolldownOutputOptions }[];
  readonly policy?: {
    readonly deterministic?: boolean;
    readonly licenses?: 'strict' | 'ignore';
    readonly nativeAddons?: 'reject' | 'allow';
    readonly unresolvedImports?: 'reject' | 'allow';
  };
}

/** 编译 Profile 与其参数的唯一映射。 */
export interface CompileOptionsMap {
  readonly 'portable-node': PortableNodeCompileOptions;
  readonly 'managed-rolldown': ManagedRolldownCompileOptions;
}

/** 指定 Profile 的编译参数。 */
export type CompileOptions<P extends CompileProfile> = CompileOptionsMap[P];

/** 与当前所有者能力绑定的 Compiler Job。 */
export interface CompileJob<P extends CompileProfile> {
  readonly id: string;
  readonly profile: P;
  readonly entries: Readonly<Record<string, CompileEntry>>;
  readonly sourceScopes?: readonly SourceDirectoryRef[];
  readonly virtualModules?: Readonly<Record<string, string>>;
  readonly options?: CompileOptions<P>;
}

/** Compiler 输出的受管文件。 */
export interface CompileOutputFile {
  readonly type: 'chunk' | 'asset' | 'licenses';
  readonly outputId: string;
  readonly fileName: string;
  readonly entryId?: string;
  readonly isEntry: boolean;
  readonly asset: GeneratedAssetRef;
}

/** 脱敏后的 Compiler 模块图节点。 */
export interface CompileModuleReport {
  readonly id: string;
  readonly kind: 'source' | 'virtual' | 'package';
  readonly inputs: readonly string[];
  readonly importedBy: readonly string[];
}

/** Compiler Host 的稳定结果。 */
export interface CompileResult<P extends CompileProfile> {
  readonly job: string;
  readonly profile: P;
  readonly engine: { readonly name: 'rolldown'; readonly version: string };
  readonly outputs: readonly CompileOutputFile[];
  readonly modules: readonly CompileModuleReport[];
}

/** owner-scoped Compiler Host 能力。 */
export interface CompilerService {
  readonly engine: { readonly name: 'rolldown'; readonly version: string };
  /** 通过 Core 唯一 Compiler Host 执行 owner-scoped Job。 */
  compile<P extends CompileProfile>(job: CompileJob<P>): Promise<CompileResult<P>>;
}

/** Execution Host 的稳定进程结果。 */
export interface ExecutionResult {
  readonly status: 'exited' | 'signaled' | 'timed-out' | 'output-limit';
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly stdout: Uint8Array;
  readonly stderr: Uint8Array;
}

/** owner-scoped Node Execution Host 能力。 */
export interface ExecutionService {
  /** 在隔离 cwd、最小环境和固定资源上限内执行 Node entry。 */
  runNode(request: {
    readonly entry: GeneratedAssetRef;
    readonly args?: readonly string[];
    readonly stdin?: Uint8Array | string;
    readonly timeoutMs: number;
    readonly maxOutputBytes: number;
    readonly environment?: Readonly<Record<string, string>>;
  }): Promise<ExecutionResult>;
}

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

/** Platform 创建的主 Package 输入。 */
export interface PlatformPackageInput {
  readonly documents: readonly PackageDocumentInput[];
  readonly assets: readonly PackageAssetInput[];
  readonly compatibility: readonly CompatibilityInput[];
  readonly metadata: readonly MetadataDispositionInput[];
}

/** Package 中的 Asset 路径映射。 */
export interface PackageAssetInput {
  readonly path: string;
  readonly asset: AssetRef;
}

/** Platform 拥有的结构化 Package Document。 */
export interface PackageDocumentInput<T extends JsonValue = JsonValue> {
  readonly id: string;
  readonly path: string;
  readonly format: 'json' | 'yaml' | 'toml' | 'frontmatter';
  readonly value: Readonly<T>;
  readonly emission?: 'required' | 'omit-if-empty';
  readonly extensionPoints: readonly DocumentFieldPath[];
}

/** Package snapshot 中保留 issuer 的 Asset。 */
export interface PackageAssetSnapshot {
  readonly path: string;
  readonly owner: string;
  readonly asset: AssetRef;
}

/** Package snapshot 中冻结的结构化 Document。 */
export interface PackageDocumentSnapshot<T extends JsonValue = JsonValue> {
  readonly id: string;
  readonly path: string;
  readonly format: PackageDocumentInput['format'];
  readonly value: Readonly<T>;
  readonly emission: 'required' | 'omit-if-empty';
  readonly extensionPoints: readonly DocumentFieldPath[];
}

/** Contributor 只能读取的 Platform base snapshot。 */
export interface PlatformBasePackageSnapshot {
  readonly documents: readonly PackageDocumentSnapshot[];
  readonly assets: readonly PackageAssetSnapshot[];
  readonly compatibility: readonly CompatibilityInput[];
  readonly metadata: readonly MetadataDispositionInput[];
}

/** Core 集中合并后的 Package snapshot。 */
export type MergedPackageSnapshot = PlatformBasePackageSnapshot;

/** Platform 最终确定的主 Package 身份和新增 Asset。 */
export interface PrimaryPackageInput {
  readonly id: string;
  readonly type: PlatformDeliveryType;
  readonly assets?: readonly PackageAssetInput[];
}

/** Platform base Package 创建上下文。 */
export interface CreatePackageContext {
  readonly command: ConfigCommand;
  readonly mode: BuildMode;
  readonly project: CanonicalProject;
  readonly compiler: CompilerService;
  readonly assets: AssetService;
  readonly diagnostics: DiagnosticService;
}

/** Platform finalization 上下文。 */
export interface FinalizePackageContext extends CreatePackageContext {
  readonly package: MergedPackageSnapshot;
}

/** 已验证候选中的 Package Unit snapshot。 */
export interface PackageUnitSnapshot {
  readonly platform: string;
  readonly id: string;
  readonly type: PlatformDeliveryType | 'marketplace';
  readonly role: 'primary' | 'distribution';
  readonly assets: readonly PackageAssetSnapshot[];
  readonly compatibility: readonly CompatibilityInput[];
  readonly metadata: readonly MetadataDispositionInput[];
}

/** 临时物化且只在校验调用期间授权的候选。 */
export interface PackageCandidate {
  readonly root: string;
  readonly unit: PackageUnitSnapshot;
}

/** Platform candidate 校验上下文。 */
export interface ValidatePackageContext {
  readonly command: ConfigCommand;
  readonly mode: BuildMode;
  readonly candidate: PackageCandidate;
  readonly diagnostics: DiagnosticService;
}

/** Distribution 中的一条继承或新增 Asset。 */
export interface DistributionAssetInput {
  readonly path: string;
  readonly asset: AssetRef;
}

/** Marketplace Distribution 输入。 */
export interface DistributionPackageInput {
  readonly id: string;
  readonly type: 'marketplace';
  readonly assets: readonly DistributionAssetInput[];
}

/** Platform 创建 Distribution 的上下文。 */
export interface DistributionContext {
  readonly command: ConfigCommand;
  readonly mode: BuildMode;
  readonly project: CanonicalProject;
  readonly primary: PackageUnitSnapshot;
  readonly assets: AssetService;
  readonly diagnostics: DiagnosticService;
}

/** Platform BuildSession 私有生命周期。 */
export interface PlatformSession {
  /** 校验一个 canonical Component 的平台专属字段。 */
  validateComponent?(context: PlatformComponentValidationContext): Awaitable<void>;
  /** 从 canonical project 创建 Platform base Package。 */
  createPackage(context: CreatePackageContext): Awaitable<PlatformPackageInput>;
  /** 从集中合并的 snapshot 确定主 Package。 */
  finalizePackage(context: FinalizePackageContext): Awaitable<PrimaryPackageInput>;
  /** 校验 Core 临时物化的完整 Package candidate。 */
  validatePackage(context: ValidatePackageContext): Awaitable<void>;
  /** 从已验证主 Package 创建可选 Distribution。 */
  createDistributions?(context: DistributionContext): Awaitable<readonly DistributionPackageInput[]>;
  /** 在成功、失败或中止后释放当前 Session 状态。 */
  close?(context: IntegrationCloseContext): Awaitable<void>;
}

/** Extension 对一个 Platform 的无序 add-only Contributor。 */
export interface PlatformContributor<B> {
  readonly platform: string;
  readonly platformApiVersion: typeof LIFECYCLE_API_VERSION;
  /** 对只读 base Package 返回无序 add-only Contribution。 */
  contribute(context: ContributionContext, built: Readonly<B>): Awaitable<PackageContribution>;
}

/** Extension 对一个 Document extension point 的字段贡献。 */
export interface DocumentFieldContribution {
  readonly document: string;
  readonly path: DocumentFieldPath;
  readonly value: JsonValue;
}

/** Extension Contributor 的集中合并输入。 */
export interface PackageContribution {
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
  readonly contributors: readonly PlatformContributor<B>[];
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

/** 附加 Platform 身份的兼容性报告项。 */
export interface CompatibilityEntry extends CompatibilityInput {
  readonly platform: string;
}

/** 附加 Platform 身份的元数据报告项。 */
export interface MetadataDispositionEntry extends MetadataDispositionInput {
  readonly platform: string;
}

/** 稳定报告中的 Asset 来源。 */
export type AssetOrigin = {
  readonly type: 'source';
  readonly resource: string;
  readonly path: string;
} | {
  readonly type: 'compile';
  readonly owner: string;
  readonly job: string;
  readonly output: string;
  readonly profile: CompileProfile;
  readonly kind: CompileOutputFile['type'];
  readonly inputs: readonly string[];
} | {
  readonly type: 'generated';
  readonly owner: string;
  readonly operation: string;
  readonly subjects?: readonly string[];
};

/** BuildReport 中的 Asset 摘要。 */
export interface PackageAssetReport {
  readonly path: string;
  readonly owner: string;
  readonly mode: AssetMode;
  readonly size: number;
  readonly sha256: string;
  readonly origin: AssetOrigin;
}

/** BuildReport 中的 Package Unit 摘要。 */
export interface PackageUnitReport {
  readonly platform: string;
  readonly id: string;
  readonly type: PlatformDeliveryType | 'marketplace';
  readonly role: 'primary' | 'distribution';
  readonly validated: boolean;
  readonly assets: readonly PackageAssetReport[];
}

/** BuildReport 中的 Component 摘要。 */
export interface ComponentReport {
  readonly kind: 'command' | 'skill' | 'agent';
  readonly id: string;
  readonly location: SourceLocation;
}

/** BuildReport 中的 Runtime 摘要。 */
export interface RuntimeReport {
  readonly id: string;
  readonly kind: NodeRuntimeEntryKind;
  readonly location: SourceLocation;
  readonly built: boolean;
}

/** BuildReport 中的 Extension 摘要。 */
export interface ExtensionReport {
  readonly id: string;
  readonly discovered: boolean;
  readonly subjects: readonly ExtensionSubject[];
}

/** BuildReport 中的 Platform 摘要。 */
export interface PlatformReport {
  readonly id: string;
  readonly selected: boolean;
  readonly success: boolean;
  readonly packageIds: readonly string[];
}

/** 稳定诊断阶段。 */
export type DiagnosticPhase = 'config' | 'setup' | 'discover' | 'validate' | 'compile' | 'package' | 'contribute' | 'finalize' | 'materialize' | 'platform-validate' | 'compatibility' | 'transaction' | 'cleanup' | 'dev' | 'internal';

/** BuildReport 中已绑定来源的诊断。 */
export interface Diagnostic extends DiagnosticInput {
  readonly phase: DiagnosticPhase;
  readonly platform?: string;
  readonly extension?: string;
  readonly owner?: string;
  readonly component?: { readonly kind: 'command' | 'skill' | 'agent'; readonly id: string };
  readonly related?: readonly SourceLocation[];
}

/** Kernel v2 唯一公开构建报告。 */
export interface BuildReport {
  readonly schemaVersion: 2;
  readonly framework: { readonly name: 'acplugin'; readonly version: string };
  readonly compiler: { readonly name: 'rolldown'; readonly version: string };
  readonly success: boolean;
  readonly command: ConfigCommand;
  readonly mode: BuildMode;
  readonly committed: boolean;
  readonly components: readonly ComponentReport[];
  readonly runtimes: readonly RuntimeReport[];
  readonly extensions: readonly ExtensionReport[];
  readonly platforms: readonly PlatformReport[];
  readonly packages: readonly PackageUnitReport[];
  readonly compatibility: readonly CompatibilityEntry[];
  readonly metadata: readonly MetadataDispositionEntry[];
  readonly diagnostics: readonly Diagnostic[];
}

/** Project 创建时固定的工程身份选项。 */
export interface CreateProjectOptions {
  readonly cwd?: string;
  readonly configFile?: string;
}

/** 单次 Project 执行选项。 */
export interface ProjectRunOptions {
  readonly command?: 'validate' | 'inspect' | 'build';
  readonly mode?: BuildMode;
  readonly platforms?: readonly string[];
  readonly commit?: boolean;
}

/** 持续构建 Session 选项。 */
export interface ProjectDevOptions {
  readonly mode?: BuildMode;
  readonly platforms?: readonly string[];
  readonly commit?: boolean;
}

/** runProject convenience 的组合选项。 */
export interface RunProjectOptions extends CreateProjectOptions, ProjectRunOptions {}

/** DevSession 发布的稳定事件。 */
export type DevSessionEvent = {
  readonly type: 'build-start';
  readonly sequence: number;
  readonly changes: readonly string[];
} | {
  readonly type: 'build-complete';
  readonly sequence: number;
  readonly changes: readonly string[];
  readonly report: BuildReport;
} | {
  readonly type: 'closed';
  readonly sequence: number;
  readonly report: BuildReport;
};

/** Core 独占 Watch ownership 的持续构建句柄。 */
export interface DevSession {
  /** 最近一次成功报告；首次构建失败时由该初始失败报告暂时播种。 */
  readonly current: BuildReport;
  /** 订阅稳定 DevSession 事件并返回取消函数。 */
  subscribe(listener: (event: DevSessionEvent) => void): () => void;
  /** 幂等关闭 Watch 与当前 BuildSession；cleanup 失败也会先完成 closed 终态。 */
  close(): Promise<void>;
  /** 无论 cleanup 是否失败都在唯一 closed 事件发布后解析。 */
  readonly closed: Promise<void>;
}

/** 绑定同一工程配置身份的程序化 Project。 */
export interface Project {
  /** 使用固定工程身份执行一次 BuildSession。 */
  run(options?: ProjectRunOptions): Promise<BuildReport>;
  /** 使用相同 Kernel 创建持续构建 Session。 */
  dev(options?: ProjectDevOptions): Promise<DevSession>;
}
