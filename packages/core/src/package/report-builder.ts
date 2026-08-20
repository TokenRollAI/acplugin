import type {
  BuildReport,
  CompatibilityEntry,
  ComponentReport,
  Diagnostic,
  ExtensionReport,
  MetadataDispositionEntry,
  PackageAssetReport,
  PackageUnitReport,
  PlatformReport,
  RuntimeReport,
} from '../contracts/reports.js';
import type { PackageUnitSnapshot } from '../contracts/packages.js';
import { AssetRegistry } from '../services/assets.js';
import { compareCodePoints } from '../security/path-policy.js';
import { snapshotJson } from './json-snapshot.js';

/** Schema v2 BuildReport 的完整内部输入。 */
export interface BuildReportInput {
  readonly frameworkVersion: string;
  readonly compilerVersion: string;
  readonly success: boolean;
  readonly command: BuildReport['command'];
  readonly mode: BuildReport['mode'];
  readonly committed: boolean;
  readonly components: readonly ComponentReport[];
  readonly runtimes: readonly RuntimeReport[];
  readonly extensions: readonly ExtensionReport[];
  readonly platforms: readonly PlatformReport[];
  readonly packages: readonly PackageUnitSnapshot[];
  readonly validatedPackages?: readonly string[];
  readonly compatibility: readonly CompatibilityEntry[];
  readonly metadata: readonly MetadataDispositionEntry[];
  readonly diagnostics: readonly Diagnostic[];
  readonly assets: AssetRegistry;
}

/** @returns Package Unit 的无歧义 report key。 */
function packageKey(unit: Pick<PackageUnitSnapshot, 'platform' | 'id'>): string {
  return `${unit.platform}/${unit.id}`;
}

/**
 * 把一个受权 Asset snapshot 投影为包含 structured origin 的报告项。
 *
 * @param unit 当前 Package Unit。
 * @param asset 当前路径映射。
 * @param registry BuildSession Asset Registry。
 * @returns 不含字节和物理来源的 Asset report。
 */
function assetReport(
  unit: PackageUnitSnapshot,
  asset: PackageUnitSnapshot['assets'][number],
  registry: AssetRegistry,
): PackageAssetReport {
  /** Package 最终映射必须已获得对应 Asset grant。 */
  const record = registry.describe(`platform:${unit.platform}`, asset.asset);
  /** origin 也跨越报告数据边界，不能复用 Registry 内部嵌套容器。 */
  return snapshotJson({
    path: asset.path,
    owner: record.owner,
    mode: record.mode,
    size: record.size,
    sha256: record.sha256,
    origin: record.origin,
  }, `Package ${packageKey(unit)} Asset report`) as unknown as PackageAssetReport;
}

/**
 * 复制一组 report JSON record，使排序不会读取调用方 getter 或可变容器。
 *
 * @param value Kernel 阶段收集的 report records。
 * @param label 稳定诊断标签。
 * @returns 深度冻结且与输入断开的 records。
 */
function reportRecords<T>(value: readonly T[], label: string): readonly T[] {
  /** report 集合先整体深拷贝，再执行业务键排序。 */
  const snapshot = snapshotJson(value, label);
  if (!Array.isArray(snapshot))
    throw new TypeError(`${label} must be an array.`);
  return snapshot as unknown as readonly T[];
}

/**
 * 创建深度冻结、稳定排序的 Schema v2 BuildReport。
 *
 * @param input Kernel 完整生命周期已验证的报告输入。
 * @returns 不含 timestamp、绝对路径、bytes 或环境值的报告。
 */
export function createBuildReport(input: BuildReportInput): BuildReport {
  /** validated key 集合来自 candidate 阶段，不从缺失 unit 推测状态。 */
  const validated = new Set(input.validatedPackages ?? []);
  /** Package assets 保留 provenance 并按 path/owner 排序。 */
  const packages: PackageUnitReport[] = input.packages.map(unit => Object.freeze({
    platform: unit.platform,
    id: unit.id,
    type: unit.type,
    role: unit.role,
    validated: validated.has(packageKey(unit)),
    assets: Object.freeze(unit.assets
      .map(asset => assetReport(unit, asset, input.assets))
      .sort((left, right) => compareCodePoints(left.path, right.path) || compareCodePoints(left.owner, right.owner))),
  })).sort((left, right) => compareCodePoints(left.platform, right.platform) || compareCodePoints(left.id, right.id));
  /** 每个无业务顺序的报告集合使用明确稳定键排序。 */
  const components = [...reportRecords(input.components, 'BuildReport components')]
    .sort((left, right) => compareCodePoints(left.kind, right.kind) || compareCodePoints(left.id, right.id));
  /** Runtime report 只按稳定 entry ID 排序。 */
  const runtimes = [...reportRecords(input.runtimes, 'BuildReport runtimes')].sort((left, right) => compareCodePoints(left.id, right.id));
  /** Extension report 只按稳定 Extension ID 排序。 */
  const extensions = [...reportRecords(input.extensions, 'BuildReport extensions')].sort((left, right) => compareCodePoints(left.id, right.id));
  /** Platform report 只按稳定 Platform ID 排序。 */
  const platforms = [...reportRecords(input.platforms, 'BuildReport platforms')].sort((left, right) => compareCodePoints(left.id, right.id));
  /** Compatibility report 使用完整 tuple key 排序。 */
  const compatibility = [...reportRecords(input.compatibility, 'BuildReport compatibility')]
    .sort((left, right) => compareCodePoints(left.platform, right.platform)
      || compareCodePoints(left.subject, right.subject) || compareCodePoints(left.capability, right.capability));
  /** Metadata report 使用 Platform/field 排序。 */
  const metadata = [...reportRecords(input.metadata, 'BuildReport metadata')]
    .sort((left, right) => compareCodePoints(left.platform, right.platform)
      || compareCodePoints(left.field, right.field));
  /** DiagnosticRegistry 已排序，报告层仍建立独立深冻副本。 */
  const diagnostics = reportRecords(input.diagnostics, 'BuildReport diagnostics');
  /** 最终整体 snapshot 同时校验 scalar 和 Package report，形成单一深冻边界。 */
  return snapshotJson({
    schemaVersion: 2,
    framework: Object.freeze({ name: 'acplugin', version: input.frameworkVersion }),
    compiler: Object.freeze({ name: 'rolldown', version: input.compilerVersion }),
    success: input.success,
    command: input.command,
    mode: input.mode,
    committed: input.committed,
    components: Object.freeze(components),
    runtimes: Object.freeze(runtimes),
    extensions: Object.freeze(extensions),
    platforms: Object.freeze(platforms),
    packages: Object.freeze(packages),
    compatibility: Object.freeze(compatibility),
    metadata: Object.freeze(metadata),
    diagnostics,
  }, 'BuildReport') as unknown as BuildReport;
}

/**
 * 把 BuildReport 编码为固定键序和单尾随换行 JSON。
 *
 * @param report 已建立边界的 Schema v2 report。
 * @returns 字节稳定 JSON 文本。
 */
export function serializeBuildReport(report: BuildReport): string {
  /** snapshotJson 同时拒绝 report 中意外出现的函数、bytes 或行为对象。 */
  return `${JSON.stringify(snapshotJson(report, 'BuildReport'), null, 2)}\n`;
}
