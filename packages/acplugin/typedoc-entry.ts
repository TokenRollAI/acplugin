/**
 * TypeDoc-only composite of the public author and Integration SDK entry points.
 * This file is excluded from package builds and tarballs.
 */
export * from './src/sdk.js';
export {
  ACPLUGIN_VERSION,
  createProject,
  defineConfig,
  initializeProject,
  nodeRuntimeArtifactPath,
  nodeRuntimeLicensesArtifactPath,
  ProjectConfigError,
  runProject,
  serializeBuildReport,
} from './src/index.js';
export type {
  BuildConfig,
  BuildReport,
  ComponentReport,
  CreateProjectOptions,
  DevSession,
  DevSessionEvent,
  ExtensionReport,
  InitOptions,
  InitPlatformId,
  InitResult,
  NodeRuntimeConfig,
  NodeRuntimeEntryInput,
  PackageAssetReport,
  PackageUnitReport,
  PlatformReport,
  Project,
  ProjectDevOptions,
  ProjectRunOptions,
  PublicConfig,
  PublicCopyRule,
  RunProjectOptions,
  RuntimeReport,
  UserConfig,
  UserConfigExport,
} from './src/index.js';
