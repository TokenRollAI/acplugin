import type { JsonObject } from './common.js';
import type {
  NodeRuntimeEntryKind,
  PluginMetadata,
} from './config.js';
import type { PortableNodeCompileOptions } from './compiler.js';
import type {
  DiagnosticService,
  SourceAssetRef,
  SourceFileRef,
} from './services.js';

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
