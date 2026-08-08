import {
  type BuildResult,
  type UserConfigExport,
} from '@acplugin/core';
import { executeProject, type RunProjectOptions } from './run-project.js';

export { antigravity } from '@acplugin/platform-antigravity';
export { claudeCode } from '@acplugin/platform-claude-code';
export { codex } from '@acplugin/platform-codex';
export { cursor } from '@acplugin/platform-cursor';
export { openCode } from '@acplugin/platform-opencode';
export { pi } from '@acplugin/platform-pi';
export type { AntigravityPlatformOptions } from '@acplugin/platform-antigravity';
export type {
  ClaudeCodeMarketplaceOptions,
  ClaudeCodeMarketplaceOwner,
  ClaudeCodePlatformOptions,
} from '@acplugin/platform-claude-code';
export type {
  CodexCategory,
  CodexInterfaceOptions,
  CodexMarketplaceInstallation,
  CodexMarketplaceOptions,
  CodexMarketplacePolicyOptions,
  CodexPlatformOptions,
} from '@acplugin/platform-codex';
export type { CursorPlatformOptions } from '@acplugin/platform-cursor';
export type { OpenCodePlatformOptions, OpenCodeWorkspaceOptions } from '@acplugin/platform-opencode';
export type { PiPackageOptions, PiPlatformOptions } from '@acplugin/platform-pi';
export { ProjectConfigError } from './project-config.js';
export type { RunProjectOptions } from './run-project.js';

// 主包只精选公开作者 API；Core 的内部 Registry、事务和品牌检查不会通过通配导出泄漏。
export {
  bytesArtifact,
  defineExtension,
  definePlatform,
  LIFECYCLE_API_VERSION,
  serializeBuildResult,
  stableJson,
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
export const ACPLUGIN_VERSION = '1.0.0';

/** 主包内置且由独立私有包实现的六个 Platform ID。 */
export const BUILTIN_PLATFORM_IDS = [
  'claude-code',
  'codex',
  'cursor',
  'antigravity',
  'opencode',
  'pi',
] as const;

/** acplugin 1.0 官方内置 Platform 的封闭联合类型。 */
export type BuiltinPlatformId = typeof BUILTIN_PLATFORM_IDS[number];

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
