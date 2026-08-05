/** acplugin 1.0 内置且默认参与构建的目标平台标识。 */
export const TARGET_IDS = ['claude-code', 'codex'] as const;

/** Core 构建管线能够响应的命令集合。 */
export const BUILD_COMMANDS = ['dev', 'validate', 'inspect', 'build'] as const;

/** 配置加载和构建行为可使用的运行模式。 */
export const BUILD_MODES = ['development', 'production'] as const;

/** 描述 Component 在目标平台上支持程度的有序等级。 */
export const COMPATIBILITY_LEVELS = ['native', 'transform', 'degraded', 'unsupported'] as const;

/** acplugin 核心层直接建模的规范 Component 类型。 */
export const COMPONENT_KINDS = ['command', 'skill', 'agent'] as const;

/** 内置目标平台标识的联合类型。 */
export type TargetId = typeof TARGET_IDS[number];

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
  path: string;
  line?: number;
  column?: number;
}

/** 构建各阶段共享的结构化诊断信息。 */
export interface Diagnostic {
  code: string;
  severity: DiagnosticSeverity;
  message: string;
  phase: string;
  target?: TargetId;
  module?: string;
  component?: { kind: ComponentKind; id: string };
  location?: SourceLocation;
  fieldPath?: readonly (string | number)[];
  related?: readonly SourceLocation[];
  hint?: string;
}

/** 记录某项能力在指定平台上的转换结果和原因。 */
export interface CompatibilityEntry {
  target: TargetId;
  subject: string;
  capability: string;
  level: CompatibilityLevel;
  transformation?: string;
  reason: string;
  causes?: readonly string[];
}

/** Component 对其他 Skill 或 Agent 的规范依赖引用。 */
export interface ComponentRequires {
  skills: readonly string[];
  agents: readonly string[];
}

/** 用户为各目标平台提供的确定性 JSON 扩展字段。 */
export interface PlatformExtensions {
  'claude-code'?: Readonly<Record<string, unknown>>;
  'codex'?: Readonly<Record<string, unknown>>;
}

/** 从 `src/commands` 扫描得到的规范 Command。 */
export interface CommandComponent {
  kind: 'command';
  id: string;
  description: string;
  argumentHint?: string;
  body: string;
  sourcePath: string;
  requires: ComponentRequires;
  extensions: PlatformExtensions;
}

/** Skill 目录中需要随主体一起发布的辅助文件。 */
export interface SkillAuxiliaryFile {
  path: string;
  sourcePath: string;
  mode: ArtifactMode;
}

/** 从 `src/skills` 扫描得到的规范 Skill。 */
export interface SkillComponent {
  kind: 'skill';
  id: string;
  description: string;
  invocation: { user: boolean; model: boolean };
  body: string;
  sourcePath: string;
  requires: ComponentRequires;
  extensions: PlatformExtensions;
  auxiliaryFiles: readonly SkillAuxiliaryFile[];
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
  kind: 'agent';
  id: string;
  description: string;
  model: AgentModel;
  capabilities: readonly AgentCapability[];
  body: string;
  sourcePath: string;
  requires: ComponentRequires;
  extensions: PlatformExtensions;
}

/** Core 构建管线能够处理的任意规范 Component。 */
export type Component = CommandComponent | SkillComponent | AgentComponent;

/** 从 Public 目录收集且尚未转换为 Artifact 的文件描述。 */
export interface PublicFile {
  sourcePath: string;
  targetPath: string;
  mode: ArtifactMode;
}

/** Scanner 完成解析与图校验后交给 Compiler 的统一工程模型。 */
export interface PluginProject {
  root: string;
  name: string;
  version: string;
  description: string;
  displayName?: string;
  commands: readonly CommandComponent[];
  skills: readonly SkillComponent[];
  agents: readonly AgentComponent[];
  publicFiles: readonly PublicFile[];
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

/** 用户可使用的目标平台简写或严格模式配置。 */
export type TargetConfig = TargetId | { id: TargetId; strict?: boolean };

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
  name: string;
  version: string;
  description: string;
  displayName?: string;
  srcDir?: string;
  public?: PublicConfig;
  targets?: readonly TargetConfig[];
  modules?: readonly AcpluginModule[];
  build?: BuildConfig;
  extensions?: PlatformExtensions;
}

/** 完成默认值合并和校验后的单个目标平台配置。 */
export interface ResolvedTarget {
  id: TargetId;
  strict: boolean;
}

/** 完成目录解析和默认值合并后的 Public 配置。 */
export interface ResolvedPublicConfig {
  enabled: boolean;
  dir: string;
  copy?: readonly PublicCopyRule[];
}

/** Core 内部使用的完整、绝对路径化配置。 */
export interface ResolvedConfig {
  root: string;
  configPath: string;
  command: BuildCommand;
  mode: BuildMode;
  name: string;
  version: string;
  description: string;
  displayName?: string;
  srcDir: string;
  public: ResolvedPublicConfig;
  targets: readonly ResolvedTarget[];
  modules: readonly AcpluginModule[];
  outDir: string;
  strict: boolean;
  extensions: PlatformExtensions;
}

/** 已驻留内存、可安全快照的 Artifact 字节来源。 */
export interface ArtifactBytesSource {
  type: 'bytes';
  value: Uint8Array;
}

/** 构建提交阶段才读取的本地普通文件来源。 */
export interface ArtifactFileSource {
  type: 'file';
  path: string;
}

/** Compiler 或 Module 向 Artifact Graph 提交的待验证产物。 */
export interface ArtifactInput {
  path: string;
  source: ArtifactBytesSource | ArtifactFileSource;
  mode?: ArtifactMode;
}

/** Artifact Graph 校验并冻结后的不可变产物记录。 */
export interface Artifact extends ArtifactInput {
  owner: string;
  mode: ArtifactMode;
  size: number;
  sha256: string;
}

/** 某个所有者对目标平台 Manifest 字段的贡献。 */
export interface ManifestContribution {
  owner: string;
  fields: Readonly<Record<string, unknown>>;
}

/** Module 在单个目标平台生成阶段返回的增量贡献。 */
export interface TargetContribution {
  artifacts?: readonly ArtifactInput[];
  manifestFields?: Readonly<Record<string, unknown>>;
  compatibility?: readonly CompatibilityEntry[];
}

/** 加载可信 TypeScript 配置或 Module 描述文件的抽象接口。 */
export type TypeScriptModuleLoader = (path: string) => Promise<unknown>;

/** 所有 Module 生命周期阶段共享的只读上下文。 */
export interface ModuleBaseContext {
  config: ResolvedConfig;
  diagnostics: DiagnosticCollectorLike;
  loadTypeScriptModule: TypeScriptModuleLoader;
  workDir: string;
  dependencyState: ReadonlyMap<string, unknown>;
  dependencyBuiltState: ReadonlyMap<string, unknown>;
}

/** Module discover 阶段使用的基础上下文别名。 */
export type ModuleDiscoverContext = ModuleBaseContext;

/** Module validate 阶段额外携带已扫描工程的上下文。 */
export interface ModuleValidateContext extends ModuleBaseContext {
  project: PluginProject;
}

/** Module build 阶段使用的校验上下文别名。 */
export type ModuleBuildContext = ModuleValidateContext;

/** Module generate 阶段额外携带当前目标平台的上下文。 */
export interface ModuleGenerateContext extends ModuleBuildContext {
  target: TargetId;
}

/** Module buildEnd 阶段用于观察成功或失败结果的上下文。 */
export interface ModuleBuildEndContext extends ModuleBaseContext {
  error?: unknown;
}

/**
 * 通过固定生命周期 Hook 扩展 Core 构建能力的 Module 契约。
 *
 * @typeParam State discover 阶段产生并传递给后续阶段的状态。
 * @typeParam BuiltState build 阶段产生并传递给 generate 的状态。
 */
export interface AcpluginModule<State = unknown, BuiltState = unknown> {
  name: string;
  dependsOn?: readonly string[];

  /** 在配置解析完成后执行一次，不应写入构建产物。 */
  configResolved?(config: ResolvedConfig): void | Promise<void>;

  /** 发现 Module 自己拥有的资源，并返回稳定状态。 */
  discover?(context: ModuleDiscoverContext): State | Promise<State>;

  /** 校验发现状态与规范 Plugin 工程之间的约束。 */
  validate?(context: ModuleValidateContext, state: State): void | Promise<void>;

  /** 构建与目标无关的中间状态，例如本地代码 Bundle。 */
  build?(context: ModuleBuildContext, state: State): BuiltState | Promise<BuiltState>;

  /** 为当前目标平台生成 Artifact、Manifest 和兼容性贡献。 */
  generate?(
    context: ModuleGenerateContext,
    state: State,
    builtState: BuiltState,
  ): TargetContribution | void | Promise<TargetContribution | void>;

  /** 在构建结束时执行清理；失败信息通过上下文传入。 */
  buildEnd?(context: ModuleBuildEndContext): void | Promise<void>;
}

/** Compiler 编译单个平台时需要的完整输入。 */
export interface CompilerContext {
  config: ResolvedConfig;
  project: PluginProject;
  target: ResolvedTarget;
  contributions: readonly { module: string; contribution: TargetContribution }[];
  diagnostics: DiagnosticCollectorLike;
}

/** Compiler 返回给 Core 的目标产物和兼容性记录。 */
export interface CompilerOutput {
  artifacts: readonly ArtifactInput[];
  compatibility: readonly CompatibilityEntry[];
}

/** 将规范 PluginProject 编译为指定平台安装包的内置接口。 */
export interface Compiler {
  id: TargetId;

  /** 编译单个目标平台，且不得直接写入最终输出目录。 */
  compile(context: CompilerContext): CompilerOutput | Promise<CompilerOutput>;
}

/** Module 和 Compiler 用于提交结构化诊断的最小接口。 */
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

/** Build Report 中可公开展示的单个 Artifact 摘要。 */
export interface ArtifactReportEntry {
  target: TargetId;
  path: string;
  owner: string;
  mode: ArtifactMode;
  size: number;
  sha256: string;
}

/** CLI、JSON 输出和 Watch 状态共享的稳定构建报告。 */
export interface BuildReport {
  schemaVersion: '1';
  command: BuildCommand;
  mode: BuildMode;
  project: { name: string; version: string };
  targets: readonly TargetId[];
  diagnostics: readonly Diagnostic[];
  compatibility: readonly CompatibilityEntry[];
  artifacts: readonly ArtifactReportEntry[];
  success: boolean;
  committed: boolean;
}

/** 调用 Core 构建管线所需的依赖和提交策略。 */
export interface BuildRequest {
  config: ResolvedConfig;
  compilers: ReadonlyMap<TargetId, Compiler>;
  loadTypeScriptModule: TypeScriptModuleLoader;
  commit: boolean;
}

/** Core 构建调用返回的工程快照和稳定报告。 */
export interface BuildResult {
  project?: PluginProject;
  report: BuildReport;
}
