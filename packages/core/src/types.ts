import type {
  AcpluginExtension,
  AcpluginPlatform,
  DeliveryUnitRole,
  DeliveryUnitType,
  DocumentFormat,
  JsonObject,
  PlatformDeliveryType,
  PlatformId,
} from './contracts.js';

/** Core 构建管线能够响应的命令集合。 */
export const BUILD_COMMANDS = ['dev', 'validate', 'inspect', 'build'] as const;

/** 配置加载和构建行为可使用的运行模式。 */
export const BUILD_MODES = ['development', 'production'] as const;

/** 描述 Component 在目标平台上支持程度的有序等级。 */
export const COMPATIBILITY_LEVELS = ['native', 'transform', 'degraded', 'unsupported'] as const;

/** acplugin 核心层直接建模的规范 Component 类型。 */
export const COMPONENT_KINDS = ['command', 'skill', 'agent'] as const;

/** Core 构建命令名称的联合类型。 */
export type BuildCommand = typeof BUILD_COMMANDS[number];

/** 构建运行模式的联合类型。 */
export type BuildMode = typeof BUILD_MODES[number];

/** 平台兼容性等级的联合类型。 */
export type CompatibilityLevel = typeof COMPATIBILITY_LEVELS[number];

/** 规范 Component 种类的联合类型。 */
export type ComponentKind = typeof COMPONENT_KINDS[number];

/** 诊断信息允许使用的严重级别。 */
export type DiagnosticSeverity = 'error' | 'warning';

/** 产物允许写入的普通文件和可执行文件权限。 */
export type ArtifactMode = 0o644 | 0o755;

/** 指向用户工程中某个来源位置的可序列化描述。 */
export interface SourceLocation {
  readonly path: string;
  readonly line?: number;
  readonly column?: number;
}

/** 构建各阶段共享的结构化诊断信息。 */
export interface Diagnostic {
  readonly code: string;
  readonly severity: DiagnosticSeverity;
  readonly message: string;
  readonly phase: string;
  readonly platform?: PlatformId;
  readonly extension?: string;
  readonly component?: { readonly kind: ComponentKind; readonly id: string };
  readonly owner?: string;
  readonly location?: SourceLocation;
  readonly fieldPath?: readonly (string | number)[];
  readonly related?: readonly SourceLocation[];
  readonly hint?: string;
}

/** 记录某项能力在指定平台上的转换结果和原因。 */
export interface CompatibilityEntry {
  readonly platform: PlatformId;
  readonly subject: string;
  readonly capability: string;
  readonly level: CompatibilityLevel;
  readonly transformation?: string;
  readonly reason: string;
  readonly causes?: readonly string[];
}

/** 可选 Plugin 元数据在单个平台上的最终处理结果。 */
export type MetadataDisposition = 'emitted' | 'omitted';

/** 记录单个元数据字段的输出位置或省略原因。 */
export interface MetadataDispositionEntry {
  readonly platform: PlatformId;
  readonly field: string;
  readonly disposition: MetadataDisposition;
  readonly output?: string;
  readonly reason: string;
}

/** Component 对其他 Skill 或 Agent 的规范依赖引用。 */
export interface ComponentRequires {
  skills: readonly string[];
  agents: readonly string[];
}

/** Component 按已配置 Platform ID 保存的确定性专属字段。 */
export type ComponentPlatformFields = Readonly<Record<string, Readonly<JsonObject>>>;

/** 从 `src/commands` 扫描得到的规范 Command。 */
export interface CommandComponent {
  readonly kind: 'command';
  readonly id: string;
  readonly description: string;
  readonly argumentHint?: string;
  readonly body: string;
  readonly sourcePath: string;
  readonly requires: ComponentRequires;
  readonly platforms: ComponentPlatformFields;
}

/** Skill 目录中需要随主体一起发布的辅助文件。 */
export interface SkillAuxiliaryFile {
  readonly path: string;
  readonly sourcePath: string;
  readonly mode: ArtifactMode;
}

/** 从 `src/skills` 扫描得到的规范 Skill。 */
export interface SkillComponent {
  readonly kind: 'skill';
  readonly id: string;
  readonly description: string;
  readonly invocation: { readonly user: boolean; readonly model: boolean };
  readonly body: string;
  readonly sourcePath: string;
  readonly requires: ComponentRequires;
  readonly platforms: ComponentPlatformFields;
  readonly auxiliaryFiles: readonly SkillAuxiliaryFile[];
}

/** 与具体平台模型名称解耦的 Agent 能力级别。 */
export type AgentModel = 'inherit' | 'fast' | 'capable';

/** acplugin 用于描述 Agent 所需工具能力的规范集合。 */
export type AgentCapability
  = | 'filesystem:read'
    | 'filesystem:write'
    | 'search'
    | 'shell'
    | 'network'
    | 'delegate';

/** 从 `src/agents` 扫描得到的规范 Agent。 */
export interface AgentComponent {
  readonly kind: 'agent';
  readonly id: string;
  readonly description: string;
  readonly model: AgentModel;
  readonly capabilities: readonly AgentCapability[];
  readonly body: string;
  readonly sourcePath: string;
  readonly requires: ComponentRequires;
  readonly platforms: ComponentPlatformFields;
}

/** Core 构建管线能够处理的任意规范 Component。 */
export type Component = CommandComponent | SkillComponent | AgentComponent;

/** 从 Public 目录收集且尚未转换为 Artifact 的文件描述。 */
export interface PublicFile {
  readonly sourcePath: string;
  readonly targetPath: string;
  readonly mode: ArtifactMode;
}

/** Plugin 作者的统一名称、邮件与主页信息。 */
export interface PluginAuthor {
  readonly name: string;
  readonly email?: string;
  readonly url?: string;
}

/** Plugin 配置中与平台无关、可供所有生命周期只读访问的元数据。 */
export interface PluginMetadata {
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly displayName?: string;
  readonly author?: PluginAuthor;
  readonly homepage?: string;
  readonly repository?: string;
  readonly license?: string;
  readonly keywords?: readonly string[];
}

/** Scanner 完成解析与图校验后交给固定生命周期的只读工程模型。 */
export interface PluginProject {
  readonly root: string;
  readonly metadata: PluginMetadata;
  readonly commands: readonly CommandComponent[];
  readonly skills: readonly SkillComponent[];
  readonly agents: readonly AgentComponent[];
  readonly publicFiles: readonly PublicFile[];
}

/** 将 Public 目录中的来源路径映射到产物路径的复制规则。 */
export interface PublicCopyRule {
  from: string;
  to: string;
}

/** 用户可使用的 Public 目录简写或完整配置。 */
export type PublicConfig = false | string | {
  dir?: string;
  copy?: readonly PublicCopyRule[];
};

/** 控制构建输出目录和全局兼容性严格度的配置。 */
export interface BuildConfig {
  outDir?: string;
  strict?: boolean;
}

/** 调用函数式配置时传入的稳定运行环境。 */
export interface ConfigEnvironment {
  command: BuildCommand;
  mode: BuildMode;
}

/** `acplugin.config.ts` 允许导出的对象或异步配置工厂。 */
export type UserConfigExport = UserConfig | ((environment: ConfigEnvironment) => UserConfig | Promise<UserConfig>);

/** 用户在 `acplugin.config.ts` 中声明的顶层配置契约。 */
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
  readonly platforms: readonly AcpluginPlatform[];
  readonly extensions?: readonly AcpluginExtension[];
  readonly build?: BuildConfig;
}

/** 配置解析后带最终严格度的品牌化 Platform 实例。 */
export interface ResolvedPlatform {
  readonly platform: AcpluginPlatform;
  readonly strict: boolean;
}

/** 完成目录解析和默认值合并后的 Public 配置。 */
export interface ResolvedPublicConfig {
  enabled: boolean;
  dir: string;
  copy?: readonly PublicCopyRule[];
}

/** Core 内部使用的完整、绝对路径化配置。 */
export interface ResolvedConfig {
  readonly root: string;
  readonly configPath: string;
  readonly command: BuildCommand;
  readonly mode: BuildMode;
  readonly metadata: PluginMetadata;
  readonly srcDir: string;
  readonly public: ResolvedPublicConfig;
  readonly platforms: readonly ResolvedPlatform[];
  readonly extensions: readonly AcpluginExtension[];
  readonly outDir: string;
  readonly strict: boolean;
}

/** 已驻留内存、可安全快照的 Artifact 字节来源。 */
export interface ArtifactBytesSource {
  readonly type: 'bytes';
  readonly value: Uint8Array;
}

/** 构建提交阶段才读取的本地普通文件来源。 */
export interface ArtifactFileSource {
  readonly type: 'file';
  readonly path: string;
}

/** Platform 或 Extension Adapter 向 Core 提交的待验证产物。 */
export interface ArtifactInput {
  readonly path: string;
  readonly source: ArtifactBytesSource | ArtifactFileSource;
  readonly mode?: ArtifactMode;
}

/** Artifact Registry 校验并冻结后的不可变产物记录。 */
export interface Artifact extends ArtifactInput {
  readonly owner: string;
  readonly mode: ArtifactMode;
  readonly size: number;
  readonly sha256: string;
}

/** 加载可信 TypeScript 配置或 Extension 描述文件的抽象接口。 */
export type TypeScriptModuleLoader = (path: string) => Promise<unknown>;

/** Core Collector 和生命周期内部对象用于提交结构化诊断的最小接口。 */
export interface DiagnosticCollectorLike {

  /** 添加一条完整诊断，Collector 会在落盘前统一脱敏。 */
  add(diagnostic: Diagnostic): void;

  /** 添加阻止当前构建成功的错误诊断。 */
  error(code: string, message: string, options?: Partial<Omit<Diagnostic, 'code' | 'message' | 'severity'>>): void;

  /** 添加允许构建继续但需要用户关注的警告诊断。 */
  warning(code: string, message: string, options?: Partial<Omit<Diagnostic, 'code' | 'message' | 'severity'>>): void;
  readonly diagnostics: readonly Diagnostic[];
  readonly hasErrors: boolean;
}

/** BuildResult 中可公开展示且不包含内容字节的单个 Artifact 摘要。 */
export interface ArtifactReport {
  readonly path: string;
  readonly owner: string;
  readonly mode: ArtifactMode;
  readonly size: number;
  readonly sha256: string;
}

/** 一个主交付或 Distribution 的稳定、无绝对路径报告。 */
export interface DeliveryUnitReport {
  readonly platform: PlatformId;
  readonly id: string;
  readonly role: DeliveryUnitRole;
  readonly type: DeliveryUnitType;
  readonly artifacts: readonly ArtifactReport[];
}

/** inspect 报告中不暴露来源绝对路径的规范 Component 摘要。 */
export interface ComponentReport {
  readonly kind: ComponentKind;
  readonly id: string;
}

/** inspect 报告中包含严格度与交付形态的 Platform 摘要。 */
export interface PlatformReport {
  readonly id: PlatformId;
  readonly apiVersion: '1';
  readonly deliveryType: PlatformDeliveryType;
  readonly strict: boolean;
}

/** inspect 报告中包含资源发现状态的 Extension 摘要。 */
export interface ExtensionReport {
  readonly name: string;
  readonly apiVersion: '1';
  readonly hasResources: boolean;
}

/** inspect 报告中不包含结构化值或内容字节的 Platform Document 摘要。 */
export interface DocumentReport {
  readonly platform: PlatformId;
  readonly id: string;
  readonly path: string;
  readonly format: DocumentFormat;
  readonly owner: `platform:${string}`;
}

/** CLI、JSON 输出、Watch 状态与公开运行时共享的 Schema v1 构建结果。 */
export interface BuildResult {
  readonly schemaVersion: '1';
  readonly command: BuildCommand;
  readonly success: boolean;
  readonly committed: boolean;
  readonly platforms: readonly PlatformId[];
  readonly platformDetails: readonly PlatformReport[];
  readonly components: readonly ComponentReport[];
  readonly extensions: readonly ExtensionReport[];
  readonly documents: readonly DocumentReport[];
  readonly deliveryUnits: readonly DeliveryUnitReport[];
  readonly diagnostics: readonly Diagnostic[];
  readonly compatibility: readonly CompatibilityEntry[];
  readonly metadata: readonly MetadataDispositionEntry[];
}
