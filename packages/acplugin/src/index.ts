import type {
  BuildReport,
  UserConfigExport,
} from '@acplugin/core/kernel-author';
import { stableJson } from '@acplugin/core/kernel-author';
export { createProject, ProjectConfigError, runProject } from './project.js';
export { ACPLUGIN_VERSION } from './version.js';
export {
  nodeRuntimeArtifactPath,
  nodeRuntimeLicensesArtifactPath,
} from '@acplugin/core/kernel-author';

export { initializeProject } from './init.js';
export type { InitOptions, InitPlatformId, InitResult } from './init.js';

/**
 * 为 acplugin.config.ts 提供类型推断友好的恒等辅助函数。
 *
 * @param config 静态配置对象或按命令和模式生成配置的函数。
 * @returns 未修改的配置导出。
 */
export function defineConfig<const T extends UserConfigExport>(config: T): T {
  return config;
}

/**
 * 把已经规范化的 BuildReport 序列化为稳定 JSON 文档。
 *
 * @param report Kernel v2 构建报告。
 * @returns 两空格缩进且以单个换行结尾的 JSON。
 */
export function serializeBuildReport(report: BuildReport): string {
  return stableJson(report);
}

// 根入口只公开普通作者和程序化调用方契约；Integration 生命周期只位于 ./sdk。
export type {
  AgentCapability,
  AgentModel,
  AssetMode,
  AssetOrigin,
  BuildConfig,
  BuildMode,
  BuildReport,
  CompatibilityEntry,
  CompatibilityLevel,
  ComponentReport,
  ConfigCommand,
  ConfigEnvironment,
  CreateProjectOptions,
  DevSession,
  DevSessionEvent,
  Diagnostic,
  DiagnosticInput,
  DiagnosticPhase,
  ExtensionReport,
  ExtensionSubject,
  MetadataDisposition,
  MetadataDispositionEntry,
  NodeRuntimeConfig,
  NodeRuntimeEntryInput,
  NodeRuntimeEntryKind,
  PackageAssetReport,
  PackageUnitReport,
  PlatformReport,
  PlatformDeliveryType,
  PluginAuthor,
  PluginMetadata,
  Project,
  ProjectDevOptions,
  ProjectRunOptions,
  PortableNodeCompileOptions,
  PortableNodeResolveOptions,
  PortableNodeTransformOptions,
  PublicConfig,
  PublicCopyRule,
  RunProjectOptions,
  RuntimeReport,
  SourceLocation,
  UserConfig,
  UserConfigExport,
} from '@acplugin/core/kernel-author';
