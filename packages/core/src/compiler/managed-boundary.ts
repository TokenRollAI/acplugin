import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { ManagedRolldownPlugin } from '../kernel-types.js';
import { isInsidePath } from '../kernel/path-policy.js';

/** 由正常 bare import 解析证明的 package 边界。 */
export interface ManagedPackageScope {
  readonly name: string;
  readonly version: string;
  readonly root: string;
}

/** managed resolver 需要的 owner 物理来源边界。 */
export interface ManagedResolutionScopes {
  readonly sourceRoots: readonly string[];
  readonly workRoot: string;
  readonly packages: Map<string, ManagedPackageScope>;
}

/**
 * 把 Rolldown module ID 收窄为物理绝对路径。
 *
 * @param id Rolldown 模块 ID。
 * @returns 去除 query 的绝对路径，虚拟/裸 ID 返回 undefined。
 */
function moduleFile(id: string): string | undefined {
  /** query 不属于物理文件身份。 */
  const value = id.replace(/\?.*$/u, '');
  return path.isAbsolute(value) ? path.normalize(value) : undefined;
}

/**
 * 判断 import specifier 是否不携带本地路径语义。
 *
 * @param source import specifier。
 * @returns bare package/imports specifier 返回 true。
 */
function isBareSpecifier(source: string): boolean {
  return !source.startsWith('.')
    && !source.startsWith('/')
    && !source.startsWith('file:')
    && !path.isAbsolute(source)
    && !source.startsWith('\0');
}

/**
 * 从 bare specifier 提取预期 package name。
 *
 * @param source bare import specifier。
 * @returns scoped/unscoped 根包名，package imports 返回 undefined。
 */
function barePackageName(source: string): string | undefined {
  if (!isBareSpecifier(source) || source.startsWith('#'))
    return undefined;
  /** scoped 与 unscoped package 的路径分段。 */
  const segments = source.split('/');
  return source.startsWith('@')
    ? segments.length >= 2 ? `${segments[0]}/${segments[1]}` : undefined
    : segments[0] || undefined;
}

/**
 * 查找已解析模块最近的 package 身份。
 *
 * @param file package manager 解析后的文件。
 * @returns 有 name/version 的普通 manifest 边界。
 */
export async function packageScope(file: string): Promise<ManagedPackageScope | undefined> {
  /** package manager symlink 解析后的真实模块路径。 */
  const real = await fs.realpath(file).catch(() => path.normalize(file));
  /** 从模块目录开始向上查找最近 manifest。 */
  let directory = path.dirname(real);
  while (true) {
    /** 当前候选 package manifest。 */
    const manifest = path.join(directory, 'package.json');
    try {
      /** manifest 必须是非 symlink 普通文件。 */
      const stat = await fs.lstat(manifest);
      if (!stat.isFile() || stat.isSymbolicLink())
        return undefined;
      /** 依赖授权只使用稳定身份字段。 */
      const data = JSON.parse(await fs.readFile(manifest, 'utf8')) as { readonly name?: unknown; readonly version?: unknown };
      if (typeof data.name === 'string' && data.name.length > 0
        && typeof data.version === 'string' && data.version.length > 0) {
        return Object.freeze({ name: data.name, version: data.version, root: directory });
      }
      /** dist/esm/package.json 等仅声明 type 的嵌套 manifest 不是 package identity 边界。 */
    } catch /** error 只区分 manifest 不存在与无法读取。 */ (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        return undefined;
    }
    /** 父目录用于稳定终止向上查找。 */
    const parent = path.dirname(directory);
    if (parent === directory)
      return undefined;
    directory = parent;
  }
}

/**
 * 查找已批准的 importer package。
 *
 * @param packages 当前 Job 已证明 package 集合。
 * @param importerFile importer 真实路径。
 * @returns 包含 importer 的 package 边界。
 */
function importerPackage(
  packages: ReadonlyMap<string, ManagedPackageScope>,
  importerFile: string | undefined,
): ManagedPackageScope | undefined {
  if (importerFile === undefined)
    return undefined;
  return [...packages.values()].find(scope => isInsidePath(scope.root, importerFile));
}

/**
 * 建立 Core 插入的受管解析边界。
 *
 * Plugin 先调用后续 trusted resolver，再对结果建立 source/work/package
 * 授权。最终 module audit 仍会在 generate() 返回后独立复核此集合。
 *
 * @param scopes 当前 Job 的可变 package 证明集与固定来源根。
 * @returns 必须位于调用方 Plugin 之前的 Core resolver。
 */
export function managedSourceBoundaryPlugin(scopes: ManagedResolutionScopes): ManagedRolldownPlugin {
  return Object.freeze({
    name: 'acplugin-source-boundary',
    resolveId: {
      order: 'pre' as const,
      /** 解析后立即建立 source/work/package 证明。 */
      async handler(source, importer, options) {
        /** skipSelf 保留用户 Plugin、Core virtual Plugin 和 Rolldown resolver 语义。 */
        const resolved = await this.resolve(source, importer, { ...options, skipSelf: true });
        if (resolved === null || resolved.external)
          return resolved;
        /** 已解析结果中的物理文件。 */
        const file = moduleFile(resolved.id);
        if (file === undefined)
          return resolved;
        /** package manager symlink 解析后的真实模块路径。 */
        const real = await fs.realpath(file).catch(() => path.normalize(file));
        if (scopes.sourceRoots.some(root => isInsidePath(root, real)) || isInsidePath(scopes.workRoot, real))
          return { ...resolved, id: real };
        /** 当前 importer 的可选真实文件。 */
        const importerFile = importer === undefined
          ? undefined
          : await fs.realpath(moduleFile(importer) ?? '').catch(() => moduleFile(importer));
        /** importer 已经证明的 package 边界。 */
        const parentPackage = importerPackage(scopes.packages, importerFile);
        if (parentPackage !== undefined && isInsidePath(parentPackage.root, real))
          return { ...resolved, id: real };
        /** bare specifier 显式声明的 package 名。 */
        const expectedName = barePackageName(source);
        if (expectedName !== undefined) {
          /** 已解析模块最近的 manifest 身份。 */
          const dependency = await packageScope(real);
          if (dependency !== undefined && dependency.name === expectedName) {
            scopes.packages.set(dependency.root, dependency);
            return { ...resolved, id: real };
          }
        }
        throw new Error('Managed Rolldown resolution escaped authorized sources without a package dependency boundary.');
      },
    },
  });
}
