/** 单 Platform 的 Package、Contribution、Finalize 与 Candidate 流水线。 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { BuildMode, ConfigCommand } from '../contracts/config.js';
import type { CanonicalProject } from '../contracts/components.js';
import type { MergedPackageSnapshot, PackageUnitSnapshot } from '../contracts/packages.js';
import { CompilerHost } from '../compiler/compiler-service.js';
import { collectDistributionPackages } from '../package/distributions.js';
import { withPackageCandidate, materializePackageUnits, validatePackageUnits } from '../package/candidate-materializer.js';
import {
  createBasePackage,
  finalizePrimaryPackage,
  mergePackageContributions,
  type OwnedPackageContribution,
} from '../package/registry.js';
import {
  collectExtensionContributions,
  type BuiltExtensionState,
  type ExtensionConsumerPlan,
} from '../resources/extensions.js';
import {
  nodeRuntimeContribution,
  platformSupportsNodeRuntime,
  type BuiltNodeRuntime,
} from '../resources/runtime/provider.js';
import { AssetRegistry } from '../services/assets.js';
import { DiagnosticRegistry } from '../services/diagnostics.js';
import { WorkDirectoryRegistry } from '../services/work-directories.js';
import {
  platformConsumesFailedExtension,
  platformHasErrors,
  runPlatformStage,
  type ExtensionPlanBuildStatus,
  type PlatformRuntime,
} from './integration-sessions.js';

/** 单 Platform 完成全部候选校验后的不可变结果。 */
export interface PlatformPipelineResult {
  readonly platform: PlatformRuntime;
  readonly merged: MergedPackageSnapshot;
  readonly units: readonly PackageUnitSnapshot[];
}

/** 向单个选中 Platform 授予 canonical auxiliary 和 Public AssetRef。 */
function grantProjectAssets(project: CanonicalProject, platform: string, assets: AssetRegistry): void {
  /** grantee 与 Platform Session 的 owner identity 完全一致。 */
  const grantee = `platform:${platform}`;
  for (const skill of project.skills) {
    for (const auxiliary of skill.auxiliaryFiles)
      assets.grant('framework:canonical', grantee, auxiliary.asset);
  }
  for (const file of project.publicFiles)
    assets.grant('framework:public', grantee, file.asset);
}

/** Framework Resource 对当前 Platform 的 add-only Contributions。 */
function frameworkContributions(
  project: CanonicalProject,
  runtime: BuiltNodeRuntime | undefined,
  platform: PlatformRuntime['description'],
  assets: AssetRegistry,
): readonly OwnedPackageContribution[] {
  /** Public 与 Runtime 使用独立 owner，保持来源、冲突和 report 可审计。 */
  const contributions: OwnedPackageContribution[] = [];
  if (project.publicFiles.length > 0) {
    contributions.push(Object.freeze({
      owner: 'framework:public',
      contribution: Object.freeze({
        assets: Object.freeze(project.publicFiles.map(file => Object.freeze({ path: file.path, asset: file.asset }))),
        compatibility: Object.freeze([]),
      }),
    }));
  }
  if (project.runtime !== undefined) {
    /** 支持 Platform 获得相同 GeneratedAssetRef 的显式继承 grant。 */
    if (runtime !== undefined && platformSupportsNodeRuntime(platform)) {
      for (const entry of runtime.entries) {
        assets.grant('framework:node-runtime', `platform:${platform.id}`, entry.main);
        if (entry.licenses !== undefined)
          assets.grant('framework:node-runtime', `platform:${platform.id}`, entry.licenses);
      }
    }
    contributions.push(Object.freeze({
      owner: 'framework:node-runtime',
      contribution: nodeRuntimeContribution(project.runtime, runtime, platform),
    }));
  }
  return Object.freeze(contributions);
}

/** 物化并调用 Platform validator，保持两种失败阶段互相独立。 */
async function validatePlatformCandidate(options: {
  readonly platform: PlatformRuntime;
  readonly unit: PackageUnitSnapshot;
  readonly command: ConfigCommand;
  readonly mode: BuildMode;
  readonly assets: AssetRegistry;
  readonly workDirectories: WorkDirectoryRegistry;
  readonly diagnostics: DiagnosticRegistry;
}): Promise<boolean> {
  /** id 同时绑定 candidate 临时目录、诊断 owner 和 Platform Session。 */
  const id = options.platform.description.id;
  /** 每个平台的 candidate 只能位于其 Core-owned workDir。 */
  const temporaryParent = options.workDirectories.physicalRoot(
    `platform:${id}`,
    await options.workDirectories.directory(`platform:${id}`),
  );
  /** 外层只捕获 candidate materialize、post-validate integrity 与 cleanup failure。 */
  const materialization = await runPlatformStage(
    options.diagnostics,
    'materialize',
    'PACKAGE_CANDIDATE_MATERIALIZATION_FAILED',
    `Platform "${id}" Package "${options.unit.id}" candidate materialization failed.`,
    id,
    async () => {
      /** validatorSucceeded 让 validator failure 不必冒充 materialization exception。 */
      let validatorSucceeded = true;
      await withPackageCandidate(options.unit, options.assets, async (candidate) => {
        /** validation 只收敛 Platform callback，本地候选完整性仍交给外层。 */
        const validation = await runPlatformStage(
          options.diagnostics,
          'platform-validate',
          'PLATFORM_VALIDATE_PACKAGE_FAILED',
          `Platform "${id}" Package "${options.unit.id}" validation failed.`,
          id,
          () => options.platform.session.validatePackage(Object.freeze({
            command: options.command,
            mode: options.mode,
            candidate,
            diagnostics: options.diagnostics.service('platform-validate', { owner: `platform:${id}`, platform: id }),
          })),
        );
        /** Platform 自己报告 error 而未 throw 时也必须阻止当前 Unit 成功。 */
        validatorSucceeded = validation.ok && !platformHasErrors(options.diagnostics, id);
      }, temporaryParent);
      return validatorSucceeded;
    },
  );
  return materialization.ok && materialization.value && !platformHasErrors(options.diagnostics, id);
}

/** 在独立临时根复核全部 Unit 的 aggregate materialization closure。 */
export async function validateCompleteMaterialization(
  units: readonly PackageUnitSnapshot[],
  assets: AssetRegistry,
  workRoot: string,
): Promise<void> {
  /** complete candidate 使用当前 BuildSession workRoot 下的独立临时根。 */
  const root = await fs.mkdtemp(path.join(workRoot, 'complete-'));
  try {
    /** materialized 索引用于复核 aggregate Unit closure。 */
    const materialized = await materializePackageUnits(root, units, assets);
    await validatePackageUnits(root, units, materialized);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

/**
 * 执行单个 Platform 的固定 Package 流水线。
 *
 * 调用方仍唯一拥有跨 Platform 并发、Compatibility 汇总和事务边界。
 */
export async function runPlatformPipeline(options: {
  readonly platform: PlatformRuntime;
  readonly project: CanonicalProject;
  readonly runtime: BuiltNodeRuntime | undefined;
  readonly plans: readonly ExtensionConsumerPlan<unknown, unknown>[];
  readonly built: readonly BuiltExtensionState<unknown>[];
  readonly planBuilds: readonly ExtensionPlanBuildStatus[];
  readonly command: ConfigCommand;
  readonly mode: BuildMode;
  readonly compiler: CompilerHost;
  readonly assets: AssetRegistry;
  readonly workDirectories: WorkDirectoryRegistry;
  readonly diagnostics: DiagnosticRegistry;
}): Promise<PlatformPipelineResult | undefined> {
  /** id 同时绑定 Context owner、诊断和最终 Package namespace。 */
  const id = options.platform.description.id;
  /** 工程级错误由调用方统一阻断；本函数只隔离当前 Platform 和依赖 Extension。 */
  if (platformHasErrors(options.diagnostics, id)
    || platformConsumesFailedExtension(id, options.planBuilds))
    return undefined;

  /** createPackage 与 base snapshot validation 属于 package 阶段。 */
  const created = await runPlatformStage(
    options.diagnostics,
    'package',
    'PLATFORM_CREATE_PACKAGE_FAILED',
    `Platform "${id}" createPackage failed.`,
    id,
    async () => {
      grantProjectAssets(options.project, id, options.assets);
      return createBasePackage(id, await options.platform.session.createPackage(Object.freeze({
        command: options.command,
        mode: options.mode,
        project: options.project,
        compiler: await options.compiler.service(`platform:${id}`),
        assets: options.assets.service(`platform:${id}`),
        diagnostics: options.diagnostics.service('package', { owner: `platform:${id}`, platform: id }),
      })), options.assets);
    },
  );
  if (!created.ok || platformHasErrors(options.diagnostics, id))
    return undefined;

  /** Contributor collection、Framework contribution 与集中 merge 共用 contribute 边界。 */
  const contributed = await runPlatformStage(
    options.diagnostics,
    'contribute',
    'PLATFORM_CONTRIBUTION_FAILED',
    `Platform "${id}" Package contribution failed.`,
    id,
    async () => {
      /** Extension Contribution 全部读取 created.value 的同一对象身份。 */
      const extensionContributions = await collectExtensionContributions({
        platform: options.platform.description,
        base: created.value,
        project: options.project,
        command: options.command,
        mode: options.mode,
        plans: options.plans,
        built: options.built,
        assets: options.assets,
        diagnostics: options.diagnostics,
      });
      return mergePackageContributions(id, created.value, [
        ...frameworkContributions(options.project, options.runtime, options.platform.description, options.assets),
        ...extensionContributions,
      ], options.assets);
    },
  );
  if (!contributed.ok || platformHasErrors(options.diagnostics, id))
    return undefined;

  /** Platform finalization 只确定主 Package 身份并追加 Platform Asset。 */
  const finalized = await runPlatformStage(
    options.diagnostics,
    'finalize',
    'PLATFORM_FINALIZE_PACKAGE_FAILED',
    `Platform "${id}" primary Package finalization failed.`,
    id,
    async () => finalizePrimaryPackage(id, options.platform.resolved.definition.deliveryType, contributed.value,
      await options.platform.session.finalizePackage(Object.freeze({
        command: options.command,
        mode: options.mode,
        project: options.project,
        package: contributed.value,
        compiler: await options.compiler.service(`platform:${id}`),
        assets: options.assets.service(`platform:${id}`),
        diagnostics: options.diagnostics.service('finalize', { owner: `platform:${id}`, platform: id }),
      })), options.assets),
  );
  if (!finalized.ok || platformHasErrors(options.diagnostics, id))
    return undefined;
  if (!await validatePlatformCandidate({
    platform: options.platform,
    unit: finalized.value,
    command: options.command,
    mode: options.mode,
    assets: options.assets,
    workDirectories: options.workDirectories,
    diagnostics: options.diagnostics,
  }))
    return undefined;

  /** Distribution creation 是从已验证 primary 派生的 finalization 子阶段。 */
  const distributions = await runPlatformStage(
    options.diagnostics,
    'finalize',
    'PLATFORM_FINALIZE_PACKAGE_FAILED',
    `Platform "${id}" Distribution finalization failed.`,
    id,
    async () => options.platform.session.createDistributions === undefined
      ? Object.freeze([])
      : collectDistributionPackages({
          platform: id,
          primary: finalized.value,
          assets: options.assets,
          /** create callback 不暴露 Registry，只委托当前 Platform Session。 */
          create: scopedAssets => Promise.resolve(options.platform.session.createDistributions!(Object.freeze({
            command: options.command,
            mode: options.mode,
            project: options.project,
            primary: finalized.value,
            assets: scopedAssets,
            diagnostics: options.diagnostics.service('finalize', { owner: `platform:${id}`, platform: id }),
          }))),
        }),
  );
  if (!distributions.ok || platformHasErrors(options.diagnostics, id))
    return undefined;
  for (const distribution of distributions.value) {
    if (!await validatePlatformCandidate({
      platform: options.platform,
      unit: distribution,
      command: options.command,
      mode: options.mode,
      assets: options.assets,
      workDirectories: options.workDirectories,
      diagnostics: options.diagnostics,
    }))
      return undefined;
  }
  return Object.freeze({
    platform: options.platform,
    merged: contributed.value,
    units: Object.freeze([finalized.value, ...distributions.value]),
  });
}
