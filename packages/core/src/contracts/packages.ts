import type {
  DocumentFieldPath,
  JsonValue,
} from './common.js';
import type {
  BuildMode,
  ConfigCommand,
} from './config.js';
import type { CanonicalProject } from './components.js';
import type { CompilerService } from './compiler.js';
import type {
  CompatibilityInput,
  MetadataDispositionInput,
  PlatformDeliveryType,
} from './integrations.js';
import type {
  AssetRef,
  AssetService,
  DiagnosticService,
} from './services.js';

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
