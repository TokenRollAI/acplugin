export const TARGET_IDS = ['claude-code', 'codex'] as const;
export const BUILD_COMMANDS = ['dev', 'validate', 'inspect', 'build'] as const;
export const BUILD_MODES = ['development', 'production'] as const;
export const COMPATIBILITY_LEVELS = ['native', 'transform', 'degraded', 'unsupported'] as const;
export const COMPONENT_KINDS = ['command', 'skill', 'agent'] as const;

export type TargetId = typeof TARGET_IDS[number];
export type BuildCommand = typeof BUILD_COMMANDS[number];
export type BuildMode = typeof BUILD_MODES[number];
export type CompatibilityLevel = typeof COMPATIBILITY_LEVELS[number];
export type ComponentKind = typeof COMPONENT_KINDS[number];
export type DiagnosticSeverity = 'error' | 'warning';
export type ArtifactMode = 0o644 | 0o755;

export interface SourceLocation {
  path: string;
  line?: number;
  column?: number;
}

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

export interface CompatibilityEntry {
  target: TargetId;
  subject: string;
  capability: string;
  level: CompatibilityLevel;
  transformation?: string;
  reason: string;
  causes?: readonly string[];
}

export interface ComponentRequires {
  skills: readonly string[];
  agents: readonly string[];
}

export interface PlatformExtensions {
  'claude-code'?: Readonly<Record<string, unknown>>;
  'codex'?: Readonly<Record<string, unknown>>;
}

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

export interface SkillAuxiliaryFile {
  path: string;
  sourcePath: string;
  mode: ArtifactMode;
}

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

export type AgentModel = 'inherit' | 'fast' | 'capable';
export type AgentCapability
  = | 'filesystem:read'
    | 'filesystem:write'
    | 'search'
    | 'shell'
    | 'network'
    | 'delegate';

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

export type Component = CommandComponent | SkillComponent | AgentComponent;

export interface PublicFile {
  sourcePath: string;
  targetPath: string;
  mode: ArtifactMode;
}

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

export interface PublicCopyRule {
  from: string;
  to: string;
}

export type PublicConfig = false | string | {
  dir?: string;
  copy?: readonly PublicCopyRule[];
};

export type TargetConfig = TargetId | { id: TargetId; strict?: boolean };

export interface BuildConfig {
  outDir?: string;
  strict?: boolean;
}

export interface ConfigEnvironment {
  command: BuildCommand;
  mode: BuildMode;
}

export type UserConfigExport = UserConfig | ((environment: ConfigEnvironment) => UserConfig | Promise<UserConfig>);

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

export interface ResolvedTarget {
  id: TargetId;
  strict: boolean;
}

export interface ResolvedPublicConfig {
  enabled: boolean;
  dir: string;
  copy?: readonly PublicCopyRule[];
}

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

export interface ArtifactBytesSource {
  type: 'bytes';
  value: Uint8Array;
}

export interface ArtifactFileSource {
  type: 'file';
  path: string;
}

export interface ArtifactInput {
  path: string;
  source: ArtifactBytesSource | ArtifactFileSource;
  mode?: ArtifactMode;
}

export interface Artifact extends ArtifactInput {
  owner: string;
  mode: ArtifactMode;
  size: number;
  sha256: string;
}

export interface ManifestContribution {
  owner: string;
  fields: Readonly<Record<string, unknown>>;
}

export interface TargetContribution {
  artifacts?: readonly ArtifactInput[];
  manifestFields?: Readonly<Record<string, unknown>>;
  compatibility?: readonly CompatibilityEntry[];
}

export type TypeScriptModuleLoader = (path: string) => Promise<unknown>;

export interface ModuleBaseContext {
  config: ResolvedConfig;
  diagnostics: DiagnosticCollectorLike;
  loadTypeScriptModule: TypeScriptModuleLoader;
  workDir: string;
  dependencyState: ReadonlyMap<string, unknown>;
  dependencyBuiltState: ReadonlyMap<string, unknown>;
}

export type ModuleDiscoverContext = ModuleBaseContext;

export interface ModuleValidateContext extends ModuleBaseContext {
  project: PluginProject;
}

export type ModuleBuildContext = ModuleValidateContext;

export interface ModuleGenerateContext extends ModuleBuildContext {
  target: TargetId;
}

export interface ModuleBuildEndContext extends ModuleBaseContext {
  error?: unknown;
}

export interface AcpluginModule<State = unknown, BuiltState = unknown> {
  name: string;
  dependsOn?: readonly string[];
  configResolved?(config: ResolvedConfig): void | Promise<void>;
  discover?(context: ModuleDiscoverContext): State | Promise<State>;
  validate?(context: ModuleValidateContext, state: State): void | Promise<void>;
  build?(context: ModuleBuildContext, state: State): BuiltState | Promise<BuiltState>;
  generate?(
    context: ModuleGenerateContext,
    state: State,
    builtState: BuiltState,
  ): TargetContribution | void | Promise<TargetContribution | void>;
  buildEnd?(context: ModuleBuildEndContext): void | Promise<void>;
}

export interface CompilerContext {
  config: ResolvedConfig;
  project: PluginProject;
  target: ResolvedTarget;
  contributions: readonly { module: string; contribution: TargetContribution }[];
  diagnostics: DiagnosticCollectorLike;
}

export interface CompilerOutput {
  artifacts: readonly ArtifactInput[];
  compatibility: readonly CompatibilityEntry[];
}

export interface Compiler {
  id: TargetId;
  compile(context: CompilerContext): CompilerOutput | Promise<CompilerOutput>;
}

export interface DiagnosticCollectorLike {
  add(diagnostic: Diagnostic): void;
  error(code: string, message: string, options?: Partial<Omit<Diagnostic, 'code' | 'message' | 'severity'>>): void;
  warning(code: string, message: string, options?: Partial<Omit<Diagnostic, 'code' | 'message' | 'severity'>>): void;
  readonly diagnostics: readonly Diagnostic[];
  readonly hasErrors: boolean;
}

export interface ArtifactReportEntry {
  target: TargetId;
  path: string;
  owner: string;
  mode: ArtifactMode;
  size: number;
  sha256: string;
}

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

export interface BuildRequest {
  config: ResolvedConfig;
  compilers: ReadonlyMap<TargetId, Compiler>;
  loadTypeScriptModule: TypeScriptModuleLoader;
  commit: boolean;
}

export interface BuildResult {
  project?: PluginProject;
  report: BuildReport;
}
