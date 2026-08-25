import type {
  BuildMode,
  ConfigCommand,
  NodeRuntimeEntryKind,
} from './config.js';
import type {
  CompileOutputFile,
  CompileProfile,
} from './compiler.js';
import type {
  CompatibilityInput,
  ExtensionSubject,
  MetadataDispositionInput,
  PlatformDeliveryType,
} from './integrations.js';
import type {
  AssetMode,
  DiagnosticInput,
  SourceLocation,
} from './services.js';

/** 附加 Platform 身份的兼容性报告项。 */
export interface CompatibilityEntry extends CompatibilityInput {
  readonly platform: string;
}

/** 附加 Platform 身份的元数据报告项。 */
export interface MetadataDispositionEntry extends MetadataDispositionInput {
  readonly platform: string;
}

/** 生成 Asset 的 contribution provenance；不包含 payload、路径或平台业务类型。 */
export interface AssetContributor {
  readonly owner: string;
  readonly subject: string;
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
  readonly contributors?: readonly AssetContributor[];
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
  readonly schemaVersion: 3;
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
