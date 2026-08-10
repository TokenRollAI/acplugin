import {
  type BuildResult,
  type UserConfigExport,
} from '@acplugin/core';
import { executeProject, type RunProjectOptions } from './run-project.js';

export { ProjectConfigError } from './project-config.js';
export type { RunProjectOptions } from './run-project.js';

// 主包只精选公开作者 API；Core 的内部 Registry、事务和品牌检查不会通过通配导出泄漏。
export {
  bytesArtifact,
  defineExtension,
  definePlatform,
  LIFECYCLE_API_VERSION,
  markdownWithFrontmatter,
  serializeBuildResult,
  stableJson,
  stableYaml,
} from '@acplugin/core';
export type {
  AcpluginExtension,
  AcpluginPlatform,
  AgentCapability,
  AgentComponent,
  AgentModel,
  Artifact,
  ArtifactInput,
  ArtifactMode,
  ArtifactReport,
  Awaitable,
  BuildCommand,
  BuildConfig,
  BuildEndContext,
  BuildMode,
  BuildResult,
  BuildStartContext,
  CommandComponent,
  CompatibilityEntry,
  CompatibilityInput,
  CompatibilityLevel,
  Component,
  ComponentDescription,
  ComponentKind,
  ComponentPlatformFields,
  ComponentRequires,
  ComponentReport,
  ConfigEnvironment,
  ConfigResolvedContext,
  DeliveryUnit,
  DeliveryUnitInput,
  DeliveryUnitReport,
  DeliveryUnitRole,
  DeliveryUnitType,
  Diagnostic,
  DiagnosticInput,
  DiagnosticSeverity,
  DocumentAddPatch,
  DocumentEmission,
  DocumentFieldPath,
  DocumentFormat,
  DocumentReport,
  DraftDocument,
  ExtensionBuildContext,
  ExtensionDefinition,
  ExtensionDescription,
  ExtensionDiscoverContext,
  ExtensionPlatformAdapter,
  ExtensionReport,
  ExtensionValidateContext,
  JsonObject,
  JsonValue,
  LifecycleConfigSnapshot,
  LifecycleContext,
  MaterializedCandidate,
  MetadataDisposition,
  MetadataDispositionEntry,
  MetadataDispositionInput,
  PlatformAdapterContext,
  PlatformAdapterDescription,
  PlatformComponentValidationContext,
  PlatformDefinition,
  PlatformDeliveryType,
  PlatformDescription,
  PlatformDistributionContext,
  PlatformDraftInput,
  PlatformGenerateContext,
  PlatformId,
  PlatformPrepareContext,
  PlatformReport,
  PlatformValidateContext,
  PluginAuthor,
  PluginMetadata,
  PluginProject,
  PublicConfig,
  PublicCopyRule,
  PublicFile,
  SkillAuxiliaryFile,
  SkillComponent,
  SourceLocation,
  UserConfig,
  UserConfigExport,
} from '@acplugin/core';
export { initializeProject } from './init.js';
export type { InitOptions, InitPlatformId, InitResult } from './init.js';

/** 当前 CLI 与公开运行时 API 的版本号。 */
export const ACPLUGIN_VERSION = '0.0.1-beta';

/**
 * 为 `acplugin.config.ts` 提供类型推断友好的恒等辅助函数。
 *
 * @param config 静态配置对象或按命令和模式生成配置的函数。
 * @returns 未修改的配置导出。
 */
export function defineConfig(config: UserConfigExport): UserConfigExport {
  return config;
}

/**
 * 使用当前正式 Pipeline 运行一个项目构建请求。
 *
 * @param options 配置定位、命令模式和运行时覆盖选项。
 * @returns Core Pipeline 产生的项目与构建报告。
 */
export async function runProject(options: RunProjectOptions): Promise<BuildResult> {
  return (await executeProject(options)).result;
}
