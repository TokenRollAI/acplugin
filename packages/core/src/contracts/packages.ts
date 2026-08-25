import type {
  DocumentFieldPath,
  JsonObject,
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
  ContributedPackageComponent,
  MetadataDispositionInput,
  PackageComponentOrigin,
  PlatformDeliveryType,
} from './integrations.js';
import type {
  AssetRef,
  AssetService,
  BytesAssetRef,
  DiagnosticService,
  GeneratedBytesOriginInput,
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
  /** 仅允许当前 Platform 在 finalizePackage() 后写入的精确空字段。 */
  readonly finalizationPoints?: readonly DocumentFieldPath[];
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
  readonly finalizationPoints: readonly DocumentFieldPath[];
  /** 仅记录决定该 Document finalization field 的可信 Component 来源。 */
  readonly componentOrigins?: readonly PackageComponentOrigin[];
}

/** Contributor 只能读取的 Platform base snapshot。 */
export interface PlatformBasePackageSnapshot {
  readonly documents: readonly PackageDocumentSnapshot[];
  readonly assets: readonly PackageAssetSnapshot[];
  readonly compatibility: readonly CompatibilityInput[];
  readonly metadata: readonly MetadataDispositionInput[];
}

/** Core 集中合并后的 Package snapshot。 */
export interface MergedPackageSnapshot<TComponent extends JsonObject = JsonObject> extends PlatformBasePackageSnapshot {
  /** 仅当前 Platform 的 finalization 可见的、owner/subject-bound opaque payload。 */
  readonly components: readonly ContributedPackageComponent<TComponent>[];
}

/** 当前 Platform 对自身预留 Document finalization point 的 add-only 字段贡献。 */
export interface PlatformFinalizationFieldContribution {
  readonly document: string;
  readonly path: DocumentFieldPath;
  readonly value: JsonValue;
  /** 仅当前 finalization scope 签发的 Component origin identity 可用。 */
  readonly componentOrigins?: readonly PackageComponentOrigin[];
}

/** Platform finalization 期间生成 Bytes Asset 的扩展 provenance 输入。 */
export interface FinalizationGeneratedBytesOriginInput extends GeneratedBytesOriginInput {
  /**
   * 当前 merged Package 中实际消费的 Component 来源。
   * 若同时填写 subjects，每一项都必须来自这些 Component origin 的 subject 集合。
   */
  readonly componentOrigins?: readonly PackageComponentOrigin[];
}

/**
 * 仅在 finalizePackage() callback 内有效的 Platform AssetService。
 *
 * 标准 AssetService 永远不接受 componentOrigins；Core 只把这一窄能力交给当前
 * Platform 的 finalization，随后立即撤销。
 */
export type FinalizationAssetService = Omit<AssetService, 'fromBytes'> & Readonly<{
  fromBytes(input: {
    readonly bytes: Uint8Array | string;
    readonly mode?: import('./services.js').AssetMode;
    readonly origin: FinalizationGeneratedBytesOriginInput;
  }): Promise<BytesAssetRef>;
}>;

/** Platform 最终确定的主 Package 身份和新增 Asset。 */
export interface PrimaryPackageInput {
  readonly id: string;
  readonly type: PlatformDeliveryType;
  /** 仅当前 Platform 可写入自身预留 finalization point 的 add-only 字段。 */
  readonly documentFields?: readonly PlatformFinalizationFieldContribution[];
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
export interface FinalizePackageContext<TComponent extends JsonObject = JsonObject> extends Omit<CreatePackageContext, 'assets'> {
  readonly assets: FinalizationAssetService;
  readonly package: MergedPackageSnapshot<TComponent>;
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
