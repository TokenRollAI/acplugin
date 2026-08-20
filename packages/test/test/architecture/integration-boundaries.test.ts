import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/** Integration 架构边界守卫扫描时使用的仓库根目录。 */
const root = fileURLToPath(new URL('../../../..', import.meta.url));

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

/** 底层 Registry 不得动态或为运行时值反向加载 Compiler/lifecycle。 */
function hasServiceLayerRuntimeImport(source: string): boolean {
  if (/import\s*\(\s*['"]\.\.\/(?:compiler|lifecycle)\//u.test(source)
    || /^[ \t]*import[ \t]*['"]\.\.\/(?:compiler|lifecycle)\//mu.test(source)) {
    return true;
  }
  /** 每个指向上层的静态 import clause 用于区分 value 与纯 type specifier。 */
  const staticImports = source.matchAll(/^[ \t]*import\s+([^;]*?)\s+from\s+['"]\.\.\/(?:compiler|lifecycle)\//gmu);
  for (const match of staticImports) {
    /** import type 声明整体不会建立运行时依赖。 */
    const clause = match[1]!.trim();
    if (/^type\b/u.test(clause))
      continue;
    /** 命名 import 只有全部 specifier 都带 inline type 时才是纯类型依赖。 */
    const named = /^\{([\s\S]*)\}$/u.exec(clause);
    if (named !== null && named[1]!.split(',').every(specifier => /^type\b/u.test(specifier.trim())))
      continue;
    return true;
  }
  return false;
}

/** 架构重构完成后正式生产源码不允许保留任何 v1 架构符号。 */
const v1ArchitectureAllowlist = [] as const;

/** Integration 根入口导入的固定基线；对应包迁移后必须从列表删除。 */
const rootSdkImportAllowlist = [] as const;

/** Core 只允许 Compiler driver 与 SDK type contract 直接引用精确 Rolldown 包。 */
const directRolldownAllowlist = [
  'packages/core/src/compiler/engine-loader.ts',
  'packages/core/src/contracts/compiler.ts',
] as const;

/** CLI 与 Integration 不得建立第二个 watcher owner。 */
const watcherAllowlist = [
  'packages/core/src/lifecycle/dev-session.ts',
] as const;

/** 主包构建期间允许引用私有 Core 的精确入口。 */
const privateCoreImportAllowlist = [
  'packages/acplugin/src/author/project.ts',
  'packages/acplugin/src/index.ts',
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

/** 返回 services 生产文件中命中层级反向依赖的稳定路径。 */
async function matchingServiceLayerImports(): Promise<readonly string[]> {
  /** 只检查 Core services 本身，Compiler 可以合法消费这些 registry。 */
  const files = await sourceFiles('packages/core/src/services');
  /** 每个 Service 源码与其路径配对后检查静态 import。 */
  const sources = await Promise.all(files.map(async file => ({ file, source: await fs.readFile(path.join(root, file), 'utf8') })));
  return sources
    .filter(({ source }) => hasServiceLayerRuntimeImport(source))
    .map(({ file }) => file)
    .sort();
}

describe('Integration architecture boundary guard', () => {
  it('only shrinks the exact v1 architecture baseline', async () => {
    expect(await matchingFiles(v1ArchitecturePattern)).toEqual([...v1ArchitectureAllowlist].sort());
  });

  it('moves integrations from the root facade to the SDK subpath without new root imports', async () => {
    /** Integration 源码才受 SDK subpath 规则约束；主包 init 的作者示例合法使用根入口。 */
    const matches = (await matchingFiles(rootSdkImportPattern)).filter(file => file.startsWith('packages/platforms/') || file.startsWith('packages/extensions/'));
    expect(matches).toEqual([...rootSdkImportAllowlist].sort());
  });

  it('keeps direct Rolldown imports confined to the Core driver and type contract', async () => {
    expect(await matchingFiles(directRolldownPattern)).toEqual([...directRolldownAllowlist].sort());
  });

  it('keeps Core DevSession as the only watcher owner', async () => {
    expect(await matchingFiles(watcherPattern)).toEqual([...watcherAllowlist].sort());
  });

  it('keeps private Core imports confined to the bundled main package facade', async () => {
    expect(await matchingFiles(privateCoreImportPattern)).toEqual([...privateCoreImportAllowlist].sort());
  });

  it('keeps Core registries below compiler and lifecycle orchestration', async () => {
    expect(await matchingServiceLayerImports()).toEqual([]);
  });

  it('recognizes every runtime import form in the service-layer guard', () => {
    /** 普通、side-effect 与动态 import 都会建立运行时依赖。 */
    const runtimeImports = [
      'import { CompilerHost } from "../compiler/compiler-service.js";',
      'import "../lifecycle/build-session.js";',
      'const module = await import("../compiler/module-host.js");',
    ];
    for (const source of runtimeImports)
      expect(hasServiceLayerRuntimeImport(source)).toBe(true);
    expect(hasServiceLayerRuntimeImport('import { type Scope, CompilerHost } from "../compiler/compiler-service.js";')).toBe(true);
    expect(hasServiceLayerRuntimeImport('import type { Scope } from "../services/types.js";\nimport { CompilerHost } from "../compiler/compiler-service.js";')).toBe(true);
    /** 整体或逐 specifier 的纯类型依赖和同层 Service 依赖都不违反运行时层级。 */
    expect(hasServiceLayerRuntimeImport('import type { KernelBuildEnvironment } from "../lifecycle/build-environment.js";')).toBe(false);
    expect(hasServiceLayerRuntimeImport('import { type KernelBuildEnvironment } from "../lifecycle/build-environment.js";')).toBe(false);
    expect(hasServiceLayerRuntimeImport('import { type Scope, type Token as Identity } from "../compiler/types.js";')).toBe(false);
    expect(hasServiceLayerRuntimeImport('import { SourceRegistry } from "../services/sources.js";')).toBe(false);
  });

  it('keeps the removed Node Runtime Extension absent from the workspace', async () => {
    await expect(fs.access(path.join(root, 'packages/extensions/node-runtime'))).rejects.toThrow();
  });

  it('keeps replaced Scanner and config implementations absent', async () => {
    await expect(fs.access(path.join(root, 'packages/core/src/scanner.ts'))).rejects.toThrow();
    await expect(fs.access(path.join(root, 'packages/core/src/config.ts'))).rejects.toThrow();
    /** 全部正式生产源码用于检查解析后仍指向旧根模块的相对导入。 */
    const production = (await Promise.all(productionRoots.map(sourceFiles))).flat();
    /** 文件文本与路径配对后执行精确旧导入扫描。 */
    const imports = await Promise.all(production.map(async file => ({
      file,
      source: await fs.readFile(path.join(root, file), 'utf8'),
    })));
    /** 任意相对层级的 import specifier 都按源文件目录解析后再与旧根路径比较。 */
    const staleImports = imports.flatMap(({ file, source }) => [...source.matchAll(/from\s+['"](\.\.?\/(?:[^'"]+\/)*(?:scanner|config)\.js)['"]/gu)]
      .filter(match => ['packages/core/src/scanner.js', 'packages/core/src/config.js'].includes(path.posix.normalize(path.posix.join(path.posix.dirname(file), match[1]!))))
      .map(() => file));
    expect(staleImports).toEqual([]);
  });

  it('keeps the lifecycle API version at one during the beta rewrite', async () => {
    /** Core 基础契约中的 API version 是新架构的单一源码断言。 */
    const source = await fs.readFile(path.join(root, 'packages/core/src/contracts/common.ts'), 'utf8');
    expect(source).toContain('export const LIFECYCLE_API_VERSION = \'1\' as const;');
  });
});
