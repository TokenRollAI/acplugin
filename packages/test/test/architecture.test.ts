import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/** 架构残留扫描使用的仓库绝对根目录。 */
const root = fileURLToPath(new URL('../../..', import.meta.url));

/** 生产源码中不允许继续存在的旧运行时类型和投影字段。 */
const RETIRED_RUNTIME_PATTERN = /\b(?:TargetId|ResolvedTarget|AcpluginModule|TargetContribution|CompilerContext|CompilerOutput|CompilerRegistry|BuildRequest|legacyTargets|legacyModules|buildProject|ArtifactGraph)\b/;

/** 已正式删除且不得被 Workspace 依赖重新引入的旧包名。 */
const RETIRED_PACKAGE_PATTERN = /@acplugin\/compiler-|@tokenroll\/acplugin-module-/;

/** 允许保留旧字段文字、但只能用于定向诊断或迁移的生产源码。 */
const LEGACY_TERM_ALLOWLIST = new Set([
  'packages/acplugin/src/cli.ts',
  'packages/core/src/config.ts',
  'packages/core/src/scanner.ts',
]);

/**
 * 递归收集生产目录下的 TypeScript 源文件。
 *
 * @param directory 当前遍历目录。
 * @returns 按仓库相对路径排序的 TypeScript 文件。
 */
async function productionFiles(directory: string): Promise<string[]> {
  /** 当前目录按名称确定性排序后的目录项。 */
  const entries = await fs.readdir(path.join(root, directory), { withFileTypes: true });
  /** 当前目录及其后代累计得到的生产源码。 */
  const files: string[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name, 'en'))) {
    /** 当前目录项的仓库相对路径。 */
    const relative = path.posix.join(directory, entry.name);
    if (entry.isDirectory())
      files.push(...await productionFiles(relative));
    else if (entry.name.endsWith('.ts'))
      files.push(relative);
  }
  return files;
}

/**
 * 递归收集可能保留 Workspace 依赖、路径 Alias 或 Bundle 入口的元数据文件。
 *
 * @param directory 当前遍历的仓库相对目录。
 * @returns 排除依赖与构建产物后的稳定元数据文件列表。
 */
async function workspaceMetadataFiles(directory: string): Promise<string[]> {
  /** 当前目录按名称确定性排序后的目录项。 */
  const entries = await fs.readdir(path.join(root, directory), { withFileTypes: true });
  /** 当前目录及后代累计得到的 Workspace 元数据文件。 */
  const files: string[] = [];
  /** entry 表示当前检查的目录项。 */
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name, 'en'))) {
    if (entry.name === 'node_modules' || entry.name === 'dist')
      continue;
    /** 当前目录项的仓库相对路径。 */
    const relative = path.posix.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await workspaceMetadataFiles(relative));
    } else if (entry.name === 'package.json' || entry.name === 'tsconfig.json'
      || entry.name === 'tsdown.config.ts' || entry.name === 'vitest.config.ts') {
      files.push(relative);
    }
  }
  return files;
}

describe('retired runtime architecture guard', () => {
  it('keeps production on the single Platform/Extension lifecycle', async () => {
    /** Core、主包、Platform 和 Extension 共同构成的生产 TypeScript 范围。 */
    const files = (await Promise.all([
      'packages/core/src',
      'packages/acplugin/src',
      'packages/platforms',
      'packages/extensions',
    ].map(productionFiles))).flat();
    /** 每个违规文件及其命中类别组成的稳定列表。 */
    const violations: string[] = [];
    for (const file of files) {
      /** 当前生产源码的完整文本。 */
      const source = await fs.readFile(path.join(root, file), 'utf8');
      /** Migration 是旧输入术语唯一允许存在的生产隔离区。 */
      const isMigration = file.startsWith('packages/acplugin/src/migration/');
      if (!isMigration && RETIRED_RUNTIME_PATTERN.test(source))
        violations.push(`${file}:runtime`);
      if (!isMigration && RETIRED_PACKAGE_PATTERN.test(source))
        violations.push(`${file}:package`);
      if (!isMigration && !LEGACY_TERM_ALLOWLIST.has(file) && /(?:--target|["']targets["']|["']modules["'])/.test(source))
        violations.push(`${file}:term`);
    }

    expect(violations).toEqual([]);
  });

  it('does not retain the old Compiler or Module package directories', async () => {
    /** ACPL-012 必须从 Workspace 物理删除的旧包目录。 */
    const retiredDirectories = [
      'packages/compiler-claude-code',
      'packages/compiler-codex',
      'packages/module-hooks',
      'packages/module-mcp',
    ];
    for (const directory of retiredDirectories)
      await expect(fs.access(path.join(root, directory))).rejects.toThrow();
  });

  it('does not retain retired package names in Workspace and release metadata', async () => {
    /** 根配置与递归 Package 元数据共同覆盖依赖、Alias、Bundle、Changesets 和 Lockfile。 */
    const files = [
      '.changeset/config.json',
      'package.json',
      'pnpm-lock.yaml',
      'pnpm-workspace.yaml',
      'scripts/verify-release.mjs',
      'tsconfig.base.json',
      ...await workspaceMetadataFiles('packages'),
    ];
    /** 仍包含已删除包名的元数据文件。 */
    const violations: string[] = [];
    /** file 表示当前检查的 Workspace 元数据文件。 */
    for (const file of files) {
      /** 当前元数据文件的完整文本。 */
      const source = await fs.readFile(path.join(root, file), 'utf8');
      if (RETIRED_PACKAGE_PATTERN.test(source))
        violations.push(file);
    }

    expect(violations).toEqual([]);
  });
});
