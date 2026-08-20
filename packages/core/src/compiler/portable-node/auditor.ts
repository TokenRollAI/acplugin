/** portable-node 模块图审计。 */
import type { CompileModuleReport } from '../../contracts/compiler.js';
import { compareCodePoints } from '../../security/path-policy.js';
import type { AuditedModule } from '../managed/auditor.js';
import type { EngineOutput } from '../engine-loader.js';
import { normalizeNodeBuiltin } from './policy.js';
import { assertNoPhysicalPathBytes } from '../physical-path-auditor.js';

/** portable-node 一个入口的固定审计结果。 */
export interface PortableOutput {
  readonly bytes: Uint8Array;
  readonly modules: readonly AuditedModule[];
}

/**
 * 扫描最终输出是否泄露 Core 可知的物理根。
 *
 * @param code 最终 ESM 字节文本。
 * @param roots project/source/work/package 等物理根。
 */
/**
 * 审计一个独立 entry 的固定 Node 20 ESM 输出闭包。
 *
 * @param output Rolldown generate() 原始内存输出。
 * @param entryId 当前 stable entry ID。
 * @param modules 已授权最终模块图。
 * @param physicalRoots 不得进入产物字节的物理根。
 * @returns 唯一 main.mjs 字节。
 */
export function auditPortableOutput(
  output: EngineOutput,
  entryId: string,
  modules: readonly AuditedModule[],
  physicalRoots: readonly string[],
): PortableOutput {
  if (output.output.length !== 1 || output.output[0]?.type !== 'chunk')
    throw new Error('Portable Node must produce exactly one entry chunk and no assets.');
  /** 唯一输出必须由固定 naming policy 产生。 */
  const chunk = output.output[0];
  if (chunk.fileName !== 'main.mjs' || !chunk.isEntry || chunk.name !== entryId)
    throw new Error('Portable Node output does not match its fixed main.mjs entry contract.');
  if ((chunk.sourcemapFileName !== undefined && chunk.sourcemapFileName !== null)
    || (chunk.map !== null && chunk.map !== undefined))
    throw new Error('Portable Node must not produce sourcemaps.');
  /** Chunk 模块必须全部出现在 Plugin 外最终授权图中。 */
  const authorized = new Set(modules.map(module => module.physicalId));
  /** Rolldown 在 treeshake:false 时注入的固定内部 helper 没有 ModuleInfo，不属于作者模块。 */
  const engineInternal = new Set(['\0rolldown/runtime.js']);
  if ([...chunk.moduleIds, ...Object.keys(chunk.modules)].some(id => !authorized.has(id) && !engineInternal.has(id)))
    throw new Error('Portable Node output references a module outside the audited graph.');
  if (modules.some(module => /\.node(?:[?#]|$)/u.test(module.physicalId)) || /\.node(?:[?#'"`]|$)/u.test(chunk.code))
    throw new Error('Portable Node bundles must not contain native addons.');
  /** 唯一可保留的 external 是已规范化 node: builtin。 */
  for (const imported of chunk.imports) {
    if (normalizeNodeBuiltin(imported) !== imported)
      throw new Error('Portable Node output contains a residual non-node import.');
  }
  /** codeSplitting:false 应只留下同文件内部动态初始化，不得引用其他文件。 */
  if (chunk.dynamicImports.some(imported => imported !== 'main.mjs'))
    throw new Error('Portable Node output contains a residual dynamic import.');
  /** 最终代码按实际交付的 UTF-8 字节执行物理路径审计。 */
  const bytes = new TextEncoder().encode(chunk.code);
  assertNoPhysicalPathBytes(bytes, physicalRoots, 'Portable Node output contains an absolute build path.');
  return Object.freeze({
    bytes,
    modules: Object.freeze([...modules]),
  });
}

/**
 * 合并多个独立 entry 的脱敏模块图，保留全部稳定边。
 *
 * @param reports 每个 entry 的 module reports。
 * @returns 按逻辑 ID 排序的 Job 总图。
 */
export function mergePortableModuleReports(
  reports: readonly (readonly CompileModuleReport[])[],
): readonly CompileModuleReport[] {
  /** 同一逻辑模块可能出现在多个独立 bundle 中。 */
  const merged = new Map<string, { kind: CompileModuleReport['kind']; inputs: Set<string>; importedBy: Set<string> }>();
  for (const report of reports) {
    for (const module of report) {
      /** 当前逻辑 ID 已累积或新建的合并节点。 */
      const current = merged.get(module.id) ?? { kind: module.kind, inputs: new Set(), importedBy: new Set() };
      if (current.kind !== module.kind)
        throw new Error('Portable Node module graph contains an inconsistent logical identity.');
      for (const input of module.inputs)
        current.inputs.add(input);
      for (const importer of module.importedBy)
        current.importedBy.add(importer);
      merged.set(module.id, current);
    }
  }
  return Object.freeze([...merged.entries()]
    .sort(([left], [right]) => compareCodePoints(left, right))
    .map(([id, module]) => Object.freeze({
      id,
      kind: module.kind,
      inputs: Object.freeze([...module.inputs].sort(compareCodePoints)),
      importedBy: Object.freeze([...module.importedBy].sort(compareCodePoints)),
    })));
}
