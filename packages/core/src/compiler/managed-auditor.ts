import { promises as fs } from 'node:fs';
import path from 'node:path';
import type {
  CompileModuleReport,
  ManagedRolldownCompileOptions,
} from '../kernel-types.js';
import { compareCodePoints, isInsidePath, safeRelativePath } from '../kernel/path-policy.js';
import type { EngineOutput } from './engine-loader.js';
import type { ManagedPackageScope } from './managed-boundary.js';
import { assertNoPhysicalPathBytes } from './physical-path-auditor.js';

/** Core 从 Rolldown ModuleInfo 仅采样的审计字段。 */
export interface EngineModuleSnapshot {
  readonly importedIds: readonly string[];
  readonly dynamicallyImportedIds: readonly string[];
  readonly importers: readonly string[];
  readonly dynamicImporters: readonly string[];
}

/** 模块图审计需要的安全来源根。 */
export interface ManagedAuditScopes {
  readonly projectRoot: string;
  readonly sourceRoots: readonly string[];
  readonly workRoot: string;
  readonly packages: ReadonlyMap<string, ManagedPackageScope>;
}

/** 通过 module graph 审计的内部节点。 */
export interface AuditedModule {
  readonly physicalId: string;
  readonly logicalId: string;
  readonly kind: CompileModuleReport['kind'];
  readonly inputs: readonly string[];
  readonly importedBy: readonly string[];
}

/**
 * 返回模块图对应的内部物理 watch 观察。
 *
 * @param modules 已完成来源授权和逻辑身份脱敏的模块。
 * @returns project/source 使用物理文件，package 同时附带安全 identity。
 */
export function managedModuleWatchObservations(
  modules: readonly AuditedModule[],
): readonly { readonly path: string; readonly type: 'file'; readonly identity?: string }[] {
  return Object.freeze(modules
    .filter(module => path.isAbsolute(module.physicalId.replace(/\?.*$/u, '')))
    .map(module => Object.freeze({
      path: module.physicalId.replace(/\?.*$/u, ''),
      type: 'file' as const,
      ...(module.kind === 'package' ? { identity: module.logicalId } : {}),
    }))
    .sort((left, right) => compareCodePoints(left.path, right.path)));
}

/** 验证后的一个 Rolldown 输出文件。 */
export interface AuditedOutput {
  readonly type: 'chunk' | 'asset';
  readonly fileName: string;
  readonly entryId?: string;
  readonly isEntry: boolean;
  readonly bytes: Uint8Array;
}

/**
 * 判断一个 ID 是否为 Rolldown 或 Plugin 虚拟模块。
 *
 * @param id Rolldown 模块 ID。
 * @returns 不携带物理绝对路径时返回 true。
 */
function isVirtualId(id: string): boolean {
  return id.startsWith('\0') || !path.isAbsolute(id.replace(/\?.*$/u, ''));
}

/**
 * 把虚拟模块 ID 收敛为稳定报告身份。
 *
 * @param id 原始虚拟 ID。
 * @returns 不包含 NUL、空白或绝对路径的逻辑 ID。
 */
function virtualIdentity(id: string): string {
  /** Rolldown 内部 NUL 只是虚拟前缀，不进入稳定报告。 */
  const value = id.replace(/^\0+/u, '').replace(/\?.*$/u, '');
  if (!/^[A-Za-z0-9@._:/-]+$/.test(value) || value.includes('..') || value.startsWith('/'))
    throw new Error('Managed Rolldown produced an unsafe virtual module identity.');
  return `virtual:${value.replace(/^acplugin:/u, '')}`;
}

/**
 * 把一个物理/虚拟模块 ID 分类为安全逻辑身份。
 *
 * @param id Rolldown 模块 ID。
 * @param scopes 当前 owner 授权边界。
 * @returns 报告 ID 与种类。
 */
async function logicalModuleIdentity(
  id: string,
  scopes: ManagedAuditScopes,
): Promise<{ readonly id: string; readonly kind: CompileModuleReport['kind'] }> {
  if (isVirtualId(id))
    return Object.freeze({ id: virtualIdentity(id), kind: 'virtual' as const });
  /** query 不参与物理路径边界判定。 */
  const physical = path.normalize(id.replace(/\?.*$/u, ''));
  /** 作者来源与 owner workDir 均使用 project-relative 或 owner-local 逻辑 ID。 */
  if (scopes.sourceRoots.some(root => isInsidePath(root, physical))) {
    return Object.freeze({
      id: path.relative(scopes.projectRoot, physical).split(path.sep).join('/'),
      kind: 'source' as const,
    });
  }
  if (isInsidePath(scopes.workRoot, physical)) {
    return Object.freeze({
      id: `virtual:work/${path.relative(scopes.workRoot, physical).split(path.sep).join('/')}`,
      kind: 'virtual' as const,
    });
  }
  /** 其他物理模块必须能归属正常 package manager 依赖。 */
  const real = await fs.realpath(physical).catch(() => physical);
  /** 与 resolver 证明集匹配的依赖 package。 */
  const dependency = [...scopes.packages.values()].find(scope => isInsidePath(scope.root, real));
  if (dependency === undefined)
    throw new Error('Managed Rolldown module graph escaped authorized sources without a package boundary.');
  /** package 内相对子路径保留可审计性。 */
  const subpath = path.relative(dependency.root, real).split(path.sep).join('/');
  return Object.freeze({
    id: `package:${dependency.name}@${dependency.version}${subpath.length === 0 ? '' : `/${subpath}`}`,
    kind: 'package' as const,
  });
}

/**
 * 校验并脱敏 Rolldown 最终模块图。
 *
 * @param graph Core 审计 Plugin 捕获的原始图节点。
 * @param scopes 当前 owner 授权边界。
 * @returns 稳定排序的私有审计节点。
 */
export async function auditManagedModules(
  graph: ReadonlyMap<string, EngineModuleSnapshot>,
  scopes: ManagedAuditScopes,
): Promise<readonly AuditedModule[]> {
  /** 原始 ID 到脱敏身份的完整映射。 */
  const identities = new Map<string, { readonly id: string; readonly kind: CompileModuleReport['kind'] }>();
  for (const id of graph.keys())
    identities.set(id, await logicalModuleIdentity(id, scopes));
  /** 节点引用边仅保留已在最终图中审计的模块。 */
  const modules: AuditedModule[] = [];
  for (const [physicalId, info] of graph) {
    /** 当前物理节点的脱敏身份。 */
    const identity = identities.get(physicalId)!;
    /** 当前节点的静态与动态输入边。 */
    const inputs = [...info.importedIds, ...info.dynamicallyImportedIds]
      .map(id => identities.get(id)?.id)
      .filter((id): id is string => id !== undefined);
    /** 当前节点的静态与动态反向边。 */
    const importedBy = [...info.importers, ...info.dynamicImporters]
      .map(id => identities.get(id)?.id)
      .filter((id): id is string => id !== undefined);
    modules.push(Object.freeze({
      physicalId,
      logicalId: identity.id,
      kind: identity.kind,
      inputs: Object.freeze([...new Set(inputs)].sort(compareCodePoints)),
      importedBy: Object.freeze([...new Set(importedBy)].sort(compareCodePoints)),
    }));
  }
  return Object.freeze(modules.sort((left, right) => compareCodePoints(left.logicalId, right.logicalId)));
}

/**
 * 验证 Rolldown 输出路径、来源映射和原始字节。
 *
 * @param output Rolldown generate() 返回值。
 * @param modules 同一 build object 的已审计模块。
 * @param policy managed Profile 策略。
 * @returns 可写入 owner workDir 并签发的文件快照。
 */
export function auditManagedOutput(
  output: EngineOutput,
  modules: readonly AuditedModule[],
  policy: ManagedRolldownCompileOptions['policy'],
  physicalRoots: readonly string[],
): readonly AuditedOutput[] {
  /** 所有输出使用 exact/case/NFC 折叠键检测跨文件系统冲突。 */
  const paths = new Map<string, string>();
  /** 当前 output 的完整文件集合用于静态/动态 chunk 闭包检查。 */
  const knownFiles = new Set(output.output.map(item => safeRelativePath(item.fileName)));
  /** 当前 output 已通过的文件快照。 */
  const audited: AuditedOutput[] = [];
  /** 最终模块图的原始 ID 集合。 */
  const moduleIds = new Set(modules.map(module => module.physicalId));
  for (const item of output.output) {
    /** 不经 normalize 折叠的安全 Rolldown fileName。 */
    const fileName = safeRelativePath(item.fileName);
    /** 跨大小写/NFC 文件系统的冲突键。 */
    const collisionKey = fileName.normalize('NFC').toLowerCase();
    /** 已占用同一折叠键的先前路径。 */
    const previous = paths.get(collisionKey);
    if (previous !== undefined)
      throw new Error(`Managed Rolldown output path collision between "${previous}" and "${fileName}".`);
    paths.set(collisionKey, fileName);
    if (item.type === 'chunk') {
      /** Chunk 声明的每个模块都必须已在独立图审计中通过。 */
      for (const id of [...item.moduleIds, ...Object.keys(item.modules)]) {
        if (!moduleIds.has(id))
          throw new Error('Managed Rolldown output references a module outside the audited graph.');
      }
      if (policy?.nativeAddons === 'reject'
        && (item.moduleIds.some(id => /\.node(?:[?#]|$)/u.test(id)) || /\.node(?:[?#'"`]|$)/u.test(item.code)))
        throw new Error('Managed Rolldown output contains a native addon reference rejected by policy.');
      if (policy?.unresolvedImports === 'reject'
        && [...item.imports, ...item.dynamicImports].some(id => !knownFiles.has(id) && !id.startsWith('node:')))
        throw new Error('Managed Rolldown output contains an unresolved import rejected by policy.');
      /** Chunk 字节在任何 GeneratedAssetRef 签发前执行统一物理根审计。 */
      const bytes = new TextEncoder().encode(item.code);
      if (policy?.deterministic === true)
        assertNoPhysicalPathBytes(bytes, physicalRoots, 'Managed Rolldown deterministic output contains an absolute build path.');
      audited.push(Object.freeze({
        type: 'chunk' as const,
        fileName,
        ...(item.isEntry ? { entryId: item.name } : {}),
        isEntry: item.isEntry,
        bytes,
      }));
    } else {
      /** Asset source 必须复制，不与 Rolldown external-memory handle 共享。 */
      const bytes = typeof item.source === 'string'
        ? new TextEncoder().encode(item.source)
        : Uint8Array.from(item.source);
      if (policy?.deterministic === true)
        assertNoPhysicalPathBytes(bytes, physicalRoots, 'Managed Rolldown deterministic output contains an absolute build path.');
      audited.push(Object.freeze({ type: 'asset' as const, fileName, isEntry: false, bytes }));
    }
  }
  return Object.freeze(audited.sort((left, right) => compareCodePoints(left.fileName, right.fileName)));
}

/**
 * 把私有审计节点投影为 SDK 模块报告。
 *
 * @param modules 已脱敏私有节点。
 * @returns 不包含物理 ID 的公开结果。
 */
export function managedModuleReports(modules: readonly AuditedModule[]): readonly CompileModuleReport[] {
  return Object.freeze(modules.map(module => Object.freeze({
    id: module.logicalId,
    kind: module.kind,
    inputs: module.inputs,
    importedBy: module.importedBy,
  })));
}
