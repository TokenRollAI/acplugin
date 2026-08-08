import { compareCodeUnits, stableJson } from './serialization.js';
import {
  redactReportValue,
  sanitizeReportText,
  sortCompatibility,
  sortDiagnostics,
  sortMetadataDispositions,
  type ReportRedactionOptions,
} from './diagnostics.js';
import type {
  BuildCommand,
  BuildResult,
  CompatibilityEntry,
  ComponentReport,
  DeliveryUnitReport,
  Diagnostic,
  DocumentReport,
  ExtensionReport,
  MetadataDispositionEntry,
  PlatformReport,
} from './types.js';
import type { PlatformId } from './contracts.js';

/** 创建 Schema v1 BuildResult 所需的未排序内部输入。 */
export interface BuildResultInput {
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

/**
 * 对单个 DeliveryUnitReport 清理文本并稳定排序 Artifact。
 *
 * @param unit 尚未进入最终 BuildResult 的交付单元报告。
 * @param options 工程路径脱敏选项。
 * @returns 不含绝对路径和内容字节的确定性报告副本。
 */
function normalizeDeliveryUnitReport(
  unit: DeliveryUnitReport,
  options: ReportRedactionOptions = {},
): DeliveryUnitReport {
  return {
    ...unit,
    id: sanitizeReportText(unit.id, options),
    artifacts: unit.artifacts.map(artifact => ({
      ...artifact,
      path: sanitizeReportText(artifact.path, options),
      owner: sanitizeReportText(artifact.owner, options),
    })).sort((a, b) => compareCodeUnits(a.path, b.path) || compareCodeUnits(a.owner, b.owner)),
  };
}

/**
 * 创建供 CLI、Watch 和公开运行时共同使用的确定性 Schema v1 BuildResult。
 *
 * @param input 生命周期中按任意发现顺序收集的报告数据。
 * @param options 程序化结果也必须应用的工程路径脱敏边界。
 * @returns 已按所有稳定键排序且不包含时间戳的构建结果。
 */
export function createBuildResult(
  input: BuildResultInput,
  options: ReportRedactionOptions = {},
): BuildResult {
  /** 去重并按字典序固定的 Platform ID 列表。 */
  const platforms = [...new Set(input.platforms)].sort(compareCodeUnits);
  /** 按 Platform ID 排序的已验证 Platform 详情。 */
  const platformDetails = input.platformDetails.map(platform => ({ ...platform })).sort((left, right) => compareCodeUnits(left.id, right.id));
  /** 按种类和 ID 排序且不包含来源路径的已验证 Component 摘要。 */
  const components = input.components.map(component => ({ ...component })).sort((left, right) => compareCodeUnits(left.kind, right.kind) || compareCodeUnits(left.id, right.id));
  /** 按名称排序的已验证 Extension 摘要。 */
  const extensions = input.extensions.map(extension => ({ ...extension })).sort((left, right) => compareCodeUnits(left.name, right.name));
  /** 按 Platform、逻辑 ID 和路径排序的已验证相对 Document 摘要。 */
  const documents = input.documents.map(document => ({ ...document })).sort((left, right) => compareCodeUnits(left.platform, right.platform)
    || compareCodeUnits(left.id, right.id)
    || compareCodeUnits(left.path, right.path));
  /** 按 Platform、单元 ID、角色和类型排序的交付单元报告。 */
  const deliveryUnits = input.deliveryUnits.map(unit => normalizeDeliveryUnitReport(unit, options)).sort((a, b) =>
    compareCodeUnits(a.platform, b.platform)
    || compareCodeUnits(a.id, b.id)
    || compareCodeUnits(a.role, b.role)
    || compareCodeUnits(a.type, b.type));
  return {
    schemaVersion: '1',
    command: input.command,
    success: input.success,
    committed: input.committed,
    platforms,
    platformDetails,
    components,
    extensions,
    documents,
    deliveryUnits,
    diagnostics: sortDiagnostics(input.diagnostics, options),
    compatibility: sortCompatibility(input.compatibility, options),
    metadata: sortMetadataDispositions(input.metadata, options),
  };
}

/**
 * 把 BuildResult 深度脱敏并序列化为单个、字节稳定的 JSON 文档。
 *
 * @param result 已完成结构化排序的 Schema v1 BuildResult。
 * @param options 需要额外隐藏的工程路径边界。
 * @returns 两空格缩进、单个尾随换行且键顺序稳定的 JSON。
 */
export function serializeBuildResult(result: BuildResult, options: ReportRedactionOptions = {}): string {
  return stableJson(redactReportValue(result, options));
}
