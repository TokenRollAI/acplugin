import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/** Kernel v2 架构守卫扫描时使用的仓库根目录。 */
const root = fileURLToPath(new URL('../../..', import.meta.url));

/** 正式生产源码中不得继续新增的 v1 模型或命令式 Context API。 */
const v1ArchitecturePattern = /\b(?:executeLifecycle|PlatformDraft|DeliveryUnit|ExtensionPlatformAdapter|ProjectBuildService|ProjectModuleService|emitArtifact|patchDocument)\b/;

/** Platform/Extension 迁移到 SDK subpath 前允许保留根入口导入的精确文件集合。 */
const rootSdkImportPattern = /(?:from\s+['"]@tokenroll\/acplugin['"]|import\(\s*['"]@tokenroll\/acplugin['"])/;

/** 只有 Core Compiler Host 可以直接驱动 Rolldown。 */
const directRolldownPattern = /(?:from\s+['"](?:rolldown|@rolldown\/)|import\(\s*['"](?:rolldown|@rolldown\/))/;

/** 生产源码中 Chokidar 只能由 Core DevSession 直接拥有。 */
const watcherPattern = /(?:from\s+['"]chokidar['"]|import\(\s*['"]chokidar['"])/;

/** 主包 bundle 私有 Core 时允许保留的精确源码入口。 */
const privateCoreImportPattern = /(?:from\s+['"]@acplugin\/core(?:\/[^'"]+)?['"]|import\(\s*['"]@acplugin\/core(?:\/[^'"]+)?['"])/;

/** K2-001 完成后正式生产源码不允许保留任何 v1 架构符号。 */
const v1ArchitectureAllowlist = [] as const;

/** K2-001 固定的 Integration 根入口导入；对应包迁移后必须从列表删除。 */
const rootSdkImportAllowlist = [] as const;

/** K2-004 收敛后 Core 唯一允许的 Rolldown driver 文件。 */
const directRolldownAllowlist = [
  'packages/core/src/compiler/engine-loader.ts',
] as const;

/** CLI 与 Integration 不得建立第二个 watcher owner。 */
const watcherAllowlist = [
  'packages/core/src/kernel/dev-session.ts',
] as const;

/** 主包构建期间允许引用私有 Core 的精确入口。 */
const privateCoreImportAllowlist = [
  'packages/acplugin/src/index.ts',
  'packages/acplugin/src/project.ts',
  'packages/acplugin/src/sdk.ts',
] as const;

/** 架构扫描覆盖的正式源码根，不包含容错型 Migration legacy。 */
const productionRoots = [
  'packages/core/src',
  'packages/acplugin/src',
  'packages/platforms/claude-code/src',
  'packages/platforms/codex/src',
  'packages/platforms/cursor/src',
  'packages/platforms/antigravity/src',
  'packages/platforms/opencode/src',
  'packages/platforms/pi/src',
  'packages/extensions/hooks/src',
  'packages/extensions/mcp/src',
] as const;

/**
 * 递归收集正式 TypeScript 源码。
 *
 * @param directory 当前仓库相对目录。
 * @returns 按 UTF-16 code unit 排序的仓库相对文件列表。
 */
async function sourceFiles(directory: string): Promise<string[]> {
  /** 当前目录按名称排序后的目录项。 */
  const entries = await fs.readdir(path.join(root, directory), { withFileTypes: true });
  /** 当前目录与所有后代的 TypeScript 源码。 */
  const files: string[] = [];
  /** entry 表示当前遍历的稳定排序目录项。 */
  for (const entry of entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)) {
    /** 当前目录项的仓库相对 POSIX 路径。 */
    const relative = path.posix.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await sourceFiles(relative));
    } else if (/\.(?:ts|mts|cts)$/.test(entry.name)) {
      files.push(relative);
    }
  }
  return files;
}

/**
 * 返回命中某个架构模式的正式生产源码。
 *
 * @param pattern 需要扫描的无状态正则表达式。
 * @returns 稳定排序且排除 Migration 的命中文件。
 */
async function matchingFiles(pattern: RegExp): Promise<string[]> {
  /** 所有生产源码根递归得到的候选文件。 */
  const files = (await Promise.all(productionRoots.map(sourceFiles))).flat();
  /** 每个候选文件的路径与源码。 */
  const sources = await Promise.all(files.map(async file => ({ file, source: await fs.readFile(path.join(root, file), 'utf8') })));
  return sources
    .filter(({ file, source }) => !file.startsWith('packages/acplugin/src/migration/') && pattern.test(source))
    .map(({ file }) => file)
    .sort();
}

describe('Kernel v2 migration architecture guard', () => {
  it('only shrinks the exact v1 architecture baseline', async () => {
    expect(await matchingFiles(v1ArchitecturePattern)).toEqual([...v1ArchitectureAllowlist].sort());
  });

  it('moves integrations from the root facade to the SDK subpath without new root imports', async () => {
    /** Integration 源码才受 SDK subpath 规则约束；主包 init 的作者示例合法使用根入口。 */
    const matches = (await matchingFiles(rootSdkImportPattern)).filter(file => file.startsWith('packages/platforms/') || file.startsWith('packages/extensions/'));
    expect(matches).toEqual([...rootSdkImportAllowlist].sort());
  });

  it('keeps direct Rolldown imports confined to the current Core driver baseline', async () => {
    expect(await matchingFiles(directRolldownPattern)).toEqual([...directRolldownAllowlist].sort());
  });

  it('keeps Core DevSession as the only watcher owner', async () => {
    expect(await matchingFiles(watcherPattern)).toEqual([...watcherAllowlist].sort());
  });

  it('keeps private Core imports confined to the bundled main package facade', async () => {
    expect(await matchingFiles(privateCoreImportPattern)).toEqual([...privateCoreImportAllowlist].sort());
  });

  it('keeps the removed Node Runtime Extension absent from the workspace', async () => {
    await expect(fs.access(path.join(root, 'packages/extensions/node-runtime'))).rejects.toThrow();
  });

  it('keeps replaced Scanner and config implementations absent', async () => {
    await expect(fs.access(path.join(root, 'packages/core/src/scanner.ts'))).rejects.toThrow();
    await expect(fs.access(path.join(root, 'packages/core/src/config.ts'))).rejects.toThrow();
    /** 全部正式生产源码用于检查旧相对导入已经完全消失。 */
    const production = (await Promise.all(productionRoots.map(sourceFiles))).flat();
    /** 文件文本与路径配对后执行精确旧导入扫描。 */
    const imports = await Promise.all(production.map(async file => ({
      file,
      source: await fs.readFile(path.join(root, file), 'utf8'),
    })));
    expect(imports.filter(item => /from\s+['"]\.\/(?:scanner|config)\.js['"]/.test(item.source)).map(item => item.file)).toEqual([]);
  });

  it('keeps the lifecycle API version at one during the beta rewrite', async () => {
    /** Kernel v2 类型契约中的 API version 是新架构的单一源码断言。 */
    const source = await fs.readFile(path.join(root, 'packages/core/src/kernel-types.ts'), 'utf8');
    expect(source).toContain('export const LIFECYCLE_API_VERSION = \'1\' as const;');
  });
});
