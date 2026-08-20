/** Legacy Migration 的来源识别、stage 与 commit 编排。 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { stableJson, type Diagnostic } from '@acplugin/core';
import {
  cleanupTempDir,
  downloadGitHubRepo,
  getTempRoot,
  parseGitHubSource,
} from './legacy/github.js';
import { scanClaudeProject } from './legacy/scanner/claude.js';
import {
  hasMarketplace,
  isSinglePlugin,
  scanAllPlugins,
  scanMarketplaceMeta,
  scanPlugin,
} from './legacy/scanner/plugin.js';
import {
  allocateMigrationIds,
  relative,
  safeId,
} from './ids.js';
import type {
  MigrationFieldDraft,
  MigrationItem,
  MigrationOptions,
  MigrationReport,
} from './types.js';
import { writeCanonicalProject } from './writers/project.js';
import {
  copyText,
  exists,
  migrationItem,
} from './writers/shared.js';

export type {
  MigrationField,
  MigrationFieldOutcome,
  MigrationItem,
  MigrationOptions,
  MigrationOutcome,
  MigrationReport,
} from './types.js';

/**
 * 判断来源文本是否采用支持的 GitHub URL、前缀或 owner/repo 简写。
 *
 * @param source 用户传入的来源字符串。
 * @returns 符合 GitHub 来源语法时返回 true。
 */
function isGitHubSource(source: string): boolean {
  return source.startsWith('github:')
    || /^https?:\/\/github\.com\//.test(source)
    || (/^[A-Za-z0-9_-]+\/[A-Za-z0-9._-]+(?:#.+)?$/.test(source) && !path.isAbsolute(source));
}

/**
 * 验证最终目标尚不存在且位于旧来源树外。
 *
 * @param sourceRoot 旧来源根目录。
 * @param destination 计划提交的新工程目录。
 */
async function assertDestination(sourceRoot: string, destination: string): Promise<void> {
  if (await exists(destination))
    throw new Error('Migration destination must not exist.');
  /** 目标相对于来源的路径，用于阻止覆盖或嵌套写入旧工程。 */
  const relation = path.relative(sourceRoot, destination);
  if (relation === '' || (!path.isAbsolute(relation) && relation !== '..' && !relation.startsWith(`..${path.sep}`)))
    throw new Error('Migration destination must be outside the source tree.');
}

/**
 * 执行 Legacy 来源识别、阶段生成、Core 验证和最终目录提交。
 *
 * 所有内容先写入隔离阶段目录；只有报告成功且非 dry-run 时才通过 rename 提交。
 * GitHub 下载目录和迁移阶段目录都会在成功或失败后清理。
 *
 * @param options 来源、目标、Marketplace 选择和保真度策略。
 * @returns 不包含旧配置敏感值的稳定迁移报告。
 */
export async function migrate(options: MigrationOptions): Promise<MigrationReport> {
  /** 解析本地相对路径使用的绝对工作目录。 */
  const cwd = path.resolve(options.cwd ?? process.cwd());
  /** 本地来源或下载后仓库子目录的绝对根路径。 */
  let sourceRoot: string;
  /** GitHub 来源使用的临时下载目录清理函数。 */
  let cleanup: (() => void) | undefined;
  if (isGitHubSource(options.source) && !await exists(path.resolve(cwd, options.source))) {
    /** 完成格式和字段验证的 GitHub 来源。 */
    const source = parseGitHubSource(options.source);
    if (options.subPath)
      source.subPath = options.subPath;
    sourceRoot = await downloadGitHubRepo(source);
    /** 下载仓库对应的临时根目录。 */
    const temporaryRoot = getTempRoot(sourceRoot);
    cleanup = () => cleanupTempDir(temporaryRoot);
  } else {
    sourceRoot = path.resolve(cwd, options.source);
  }

  try {
    if (await exists(path.join(sourceRoot, 'acplugin.config.ts')))
      throw new Error('Source is already a canonical acplugin project.');
    /** 验证成功后才会出现的最终目标绝对路径。 */
    const destination = path.resolve(cwd, options.destination ?? `${path.basename(sourceRoot)}-acplugin`);
    await assertDestination(sourceRoot, destination);
    /** dry-run 使用系统临时目录，真实迁移使用目标同级目录以支持 rename 提交。 */
    const stageParent = options.dryRun ? os.tmpdir() : path.dirname(destination);
    if (!options.dryRun)
      await fs.mkdir(stageParent, { recursive: true });
    /** 当前迁移独占且失败时完整删除的阶段目录。 */
    const stage = await fs.mkdtemp(path.join(stageParent, `.${path.basename(destination)}.migration-`));
    /** 自动识别的旧来源结构类型。 */
    let sourceType: MigrationReport['sourceType'];
    /** 阶段目录内生成的规范项目路径。 */
    const projects: string[] = [];
    /** 全部资源迁移结论。 */
    const items: MigrationItem[] = [];
    /** 对全部生成工程执行 Core 校验得到的诊断。 */
    const diagnostics: Diagnostic[] = [];
    try {
      if (hasMarketplace(sourceRoot)) {
        sourceType = 'marketplace';
        /** Marketplace 聚合元数据只进入迁移记录，不复制到各单 Plugin 配置。 */
        const marketplace = scanMarketplaceMeta(sourceRoot);
        if (marketplace) {
          /** 聚合字段统一来自 Marketplace 清单，并只指向迁移报告。 */
          const source = '.claude-plugin/marketplace.json';
          /** 不会自动重建的 Marketplace 聚合字段。 */
          const fields: MigrationFieldDraft[] = [{
            field: 'name', source, outcome: 'unmapped',
            reason: 'Marketplace aggregation is recorded but not rebuilt automatically.',
          }];
          if (marketplace.owner) {
            fields.push({
              field: 'owner', source, outcome: 'unmapped',
              reason: 'Marketplace owner remains aggregation metadata for manual publishing.',
            });
          }
          fields.push({
            field: 'plugin-order', source, outcome: 'unmapped',
            reason: 'Original Plugin order remains available in the source Marketplace manifest for manual publishing.',
          });
          items.push(migrationItem({ kind: 'marketplace', id: marketplace.name, source }, fields));
        }
        /** Marketplace 中成功扫描的全部 Plugin。 */
        const plugins = scanAllPlugins(sourceRoot);
        if (options.all && options.plugin !== undefined)
          throw new Error('Marketplace migration accepts either --plugin <name> or --all, not both.');
        /** CLI --all 或 --plugin 选择的迁移对象。 */
        const selected = options.all ? plugins : plugins.filter(plugin => plugin.meta.name === options.plugin);
        if (selected.length === 0)
          throw new Error('Marketplace migration requires --plugin <name> or --all.');
        if (options.all) {
          /** 所有 workspace 成员先全局预留 base，避免目录覆盖和后缀抢占。 */
          const workspaceProjects = allocateMigrationIds(selected.map(plugin => ({
            value: plugin,
            baseId: safeId(plugin.meta.name),
            sourcePath: relative(sourceRoot, plugin.rootDir),
          })));
          // 只有批量迁移创建 workspace；每个成员仍是带独立配置的单 Plugin 工程。
          for (const allocated of workspaceProjects) {
            /** 当前已完成全局目录 ID 分配的 Marketplace Plugin。 */
            const plugin = allocated.value;
            /** Marketplace 工作区成员使用的唯一规范目录 ID。 */
            const id = allocated.id;
            /** 当前成员在迁移阶段目录中的根路径。 */
            const projectRoot = path.join(stage, id);
            /** 当前成员生成和重新扫描的结果。 */
            const result = await writeCanonicalProject(plugin, projectRoot, { ...options, name: id });
            items.push(...result.items.map((item) => {
              /** Workspace 成员前缀必须同时应用到资源与每个字段的目标路径。 */
              const destination = item.destination ? `${id}/${item.destination}` : undefined;
              return {
                ...item,
                ...(destination === undefined ? {} : { destination }),
                fields: item.fields.map(field => ({ ...field, destination: `${id}/${field.destination}` })),
              };
            }));
            diagnostics.push(...result.diagnostics);
            projects.push(id);
          }
          await copyText(path.join(stage, 'pnpm-workspace.yaml'), `packages:\n${projects.map(project => `  - ${project}`).join('\n')}\n`);
        } else {
          /** 单项选择直接写到 destination 根，不保留多余的 Marketplace 成员层级。 */
          const result = await writeCanonicalProject(selected[0]!, stage, options);
          items.push(...result.items);
          diagnostics.push(...result.diagnostics);
          projects.push('.');
        }
      } else {
        sourceType = isSinglePlugin(sourceRoot) ? 'plugin' : 'project';
        /** 根据来源类型调用对应 Legacy Scanner 的结果。 */
        const scan = sourceType === 'plugin' ? scanPlugin(sourceRoot) : scanClaudeProject(sourceRoot);
        /** 单工程生成和重新扫描的结果。 */
        const result = await writeCanonicalProject(scan, stage, options);
        items.push(...result.items);
        diagnostics.push(...result.diagnostics);
        projects.push('.');
      }
      /** 是否存在语义降级或需要人工处理的资源。 */
      const hasLoss = items.some(item => item.outcome === 'degraded' || item.outcome === 'unmapped');
      /** Core 无错误且满足可选 strict 无损条件时才允许提交。 */
      const success = !diagnostics.some(diagnostic => diagnostic.severity === 'error') && !(options.strict && hasLoss);
      /** 在阶段目录中先写入、提交后随工程一同保留的最终报告。 */
      const report: MigrationReport = {
        schemaVersion: '1', sourceType, projects, items, diagnostics,
        success, dryRun: options.dryRun ?? false,
      };
      await copyText(path.join(stage, '.acplugin-migration/report.json'), stableJson(report));
      if (success && !options.dryRun)
        await fs.rename(stage, destination);
      else
        await fs.rm(stage, { recursive: true, force: true });
      return report;
    } catch /** error 保存当前操作捕获的异常，供本阶段转换或恢复。 */ (error) {
      await fs.rm(stage, { recursive: true, force: true });
      throw error;
    }
  } finally {
    cleanup?.();
  }
}
