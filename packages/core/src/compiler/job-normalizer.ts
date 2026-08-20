import { promises as fs } from 'node:fs';
import type {
  AssetMode,
  SourceDirectoryRef,
} from '../contracts/services.js';
import type {
  CompileEntry,
  CompileJob,
  CompileProfile,
} from '../contracts/compiler.js';
import { compareCodePoints } from '../security/path-policy.js';
import { SourceRegistry } from '../services/sources.js';

/** Compiler job/output/entry 共用的稳定 ID 语法。 */
const STABLE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** 虚拟模块公开 specifier 的稳定语法。 */
const VIRTUAL_SPECIFIER = /^[a-z0-9]+(?:[-.:/][a-z0-9]+)*$/;

/** Core 快照后的一个虚拟模块。 */
export interface VirtualSource {
  readonly code: string;
  readonly resolveFrom?: string;
}

/** 已授权并解析到物理边界的 Compile Entry。 */
export interface NormalizedEntry {
  readonly id: string;
  readonly mode: AssetMode;
  readonly inputId: string;
  readonly sourceRoot: string;
}

/** 同步快照、尚未执行物理 I/O 的 source Job。 */
export interface PendingCompileSources {
  readonly id: string;
  readonly entries: readonly PendingEntry[];
  readonly scopes: readonly SourceDirectoryRef[];
  readonly virtualSources: ReadonlyMap<string, VirtualSource>;
  readonly options: unknown;
}

/** 已完成来源树复核的 Job 公共部分。 */
export interface NormalizedCompileSources {
  readonly id: string;
  readonly entries: readonly NormalizedEntry[];
  readonly virtualSources: ReadonlyMap<string, VirtualSource>;
  readonly sourceRoots: readonly string[];
}

/** 完成容器快照但尚未执行物理 I/O 的 entry。 */
type PendingEntry = {
  readonly id: string;
  readonly mode: AssetMode;
  readonly type: 'source';
  readonly source: CompileEntry & { readonly type: 'source' };
} | {
  readonly id: string;
  readonly mode: AssetMode;
  readonly type: 'virtual';
  readonly inputId: string;
  readonly code: string;
  readonly resolveFrom: SourceDirectoryRef;
};

/**
 * 确认运行时对象不使用 accessor 或 Symbol 隐藏语义。
 *
 * @param value 待检查对象。
 * @param label 稳定诊断标签。
 * @param optional 是否允许 undefined 并视为空对象。
 * @returns 全部自有 data property。
 */
export function dataProperties(
  value: unknown,
  label: string,
  optional = false,
): Record<string, PropertyDescriptor> {
  if (optional && value === undefined)
    return {};
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new TypeError(`${label} must be an object.`);
  if (Object.getOwnPropertySymbols(value).length > 0)
    throw new TypeError(`${label} must not contain symbol properties.`);
  /** descriptor 读取不会触发调用方 getter。 */
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const [field, descriptor] of Object.entries(descriptors)) {
    if (!('value' in descriptor))
      throw new TypeError(`${label}.${field} must be a data property.`);
  }
  return descriptors;
}

/**
 * 校验稳定小写 kebab-case ID。
 *
 * @param value 待验证文本。
 * @param label 诊断字段名。
 */
export function assertStableId(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !STABLE_ID.test(value))
    throw new TypeError(`${label} must use lowercase kebab-case.`);
}

/**
 * 校验 Compile Entry mode。
 *
 * @param value 调用方可选 mode。
 * @returns 只读模块默认 0644。
 */
function entryMode(value: unknown): AssetMode {
  /** 省略 mode 时使用非可执行默认值。 */
  const mode = value ?? 0o644;
  if (mode !== 0o644 && mode !== 0o755)
    throw new TypeError('Compile entry mode must be 0644 or 0755.');
  return mode;
}

/**
 * 在任何异步边界前快照 Compile Job 的公共来源结构。
 *
 * @param owner 当前 owner。
 * @param profile 期望 Profile。
 * @param job 调用方 Job。
 * @param sources SourceRef 授权注册表。
 * @returns 不再引用调用方可变容器的待解析来源。
 */
export function prepareCompileSources<P extends CompileProfile>(
  owner: string,
  profile: P,
  job: CompileJob<P>,
  sources: SourceRegistry,
): PendingCompileSources {
  /** Job 顶层的完整 data property 集。 */
  const descriptors = dataProperties(job, 'Compile job');
  for (const field of Object.keys(descriptors)) {
    if (!new Set(['id', 'profile', 'entries', 'sourceScopes', 'virtualModules', 'options']).has(field))
      throw new TypeError(`Compile job.${field} is unknown.`);
  }
  assertStableId(descriptors.id?.value, 'Compile job id');
  if (descriptors.profile?.value !== profile)
    throw new TypeError(`Compiler normalization expected profile "${profile}".`);
  /** 命名入口的完整 data property 集。 */
  const entryDescriptors = dataProperties(descriptors.entries?.value, 'Compile job entries');
  if (Object.keys(entryDescriptors).length === 0)
    throw new TypeError('Compile job entries must not be empty.');
  /** 输入 entry 在任何 await 前完成容器快照与 Ref identity 授权。 */
  const entries: PendingEntry[] = [];
  for (const id of Object.keys(entryDescriptors).sort(compareCodePoints)) {
    assertStableId(id, 'Compile entry id');
    /** 当前入口的完整 data property 集。 */
    const entry = dataProperties(entryDescriptors[id]!.value, `Compile entry "${id}"`);
    for (const field of Object.keys(entry)) {
      if (!new Set(['type', 'source', 'code', 'resolveFrom', 'mode']).has(field))
        throw new TypeError(`Compile entry "${id}".${field} is unknown.`);
    }
    /** 当前入口经校验的交付 mode。 */
    const mode = entryMode(entry.mode?.value);
    if (entry.type?.value === 'source') {
      /** 与调用方 entry 容器解除引用的 SourceRef 请求。 */
      const source = Object.freeze({ type: 'source' as const, source: entry.source?.value as never, mode });
      sources.authorizeFile(owner, source.source);
      entries.push(Object.freeze({ id, mode, type: 'source' as const, source }));
    } else if (entry.type?.value === 'virtual') {
      if (typeof entry.code?.value !== 'string')
        throw new TypeError(`Compile entry "${id}".code must be a string.`);
      /** 虚拟 entry 相对 import 使用的受权目录 ref。 */
      const resolveFrom = entry.resolveFrom?.value as SourceDirectoryRef;
      sources.authorizeDirectory(owner, resolveFrom);
      entries.push(Object.freeze({
        id,
        mode,
        type: 'virtual' as const,
        inputId: `\0acplugin:entry:${id}`,
        code: entry.code.value,
        resolveFrom,
      }));
    } else {
      throw new TypeError(`Compile entry "${id}".type must be source or virtual.`);
    }
  }
  /** 来源 scope ref 数组在任何 await 前复制并授权。 */
  const scopes: SourceDirectoryRef[] = [];
  if (descriptors.sourceScopes?.value !== undefined) {
    if (!Array.isArray(descriptors.sourceScopes.value))
      throw new TypeError('Compile job sourceScopes must be an array.');
    for (const scope of [...descriptors.sourceScopes.value]) {
      sources.authorizeDirectory(owner, scope);
      scopes.push(scope);
    }
  }
  /** 虚拟模块字典同样只接受稳定 data properties。 */
  const virtualSources = new Map<string, VirtualSource>();
  if (descriptors.virtualModules?.value !== undefined) {
    /** 虚拟模块的完整 data property 集。 */
    const modules = dataProperties(descriptors.virtualModules.value, 'Compile job virtualModules');
    for (const specifier of Object.keys(modules).sort(compareCodePoints)) {
      if (!VIRTUAL_SPECIFIER.test(specifier))
        throw new TypeError(`Virtual module specifier "${specifier}" is invalid.`);
      if (typeof modules[specifier]!.value !== 'string')
        throw new TypeError(`Virtual module "${specifier}" must contain string code.`);
      virtualSources.set(`\0acplugin:module:${specifier}`, Object.freeze({ code: modules[specifier]!.value as string }));
    }
  }
  return Object.freeze({
    id: descriptors.id.value,
    entries: Object.freeze(entries),
    scopes: Object.freeze(scopes),
    virtualSources: new Map(virtualSources),
    options: descriptors.options?.value,
  });
}

/**
 * 复核作者树、SourceRef 指纹并解析 Rolldown 所需物理来源。
 *
 * @param owner 当前 owner。
 * @param pending 同步快照后的 Job 来源。
 * @param sources SourceRef 授权注册表。
 * @returns 已完成全部 I/O 边界检查的来源。
 */
export async function resolveCompileSources(
  owner: string,
  pending: PendingCompileSources,
  sources: SourceRegistry,
): Promise<NormalizedCompileSources> {
  /** 当前 Job 的完整物理来源根。 */
  const sourceRoots = new Set<string>();
  /** 本次已递归检查的作者物理根。 */
  const validatedRoots = new Set<string>();
  /** Rolldown 可消费的最终入口。 */
  const entries: NormalizedEntry[] = [];
  /** 虚拟源码需要补上异步解析得到的物理 resolveFrom。 */
  const virtualSources = new Map(pending.virtualSources);
  for (const entry of pending.entries) {
    if (entry.type === 'source') {
      /** 已复核指纹的物理文件记录。 */
      const record = await sources.validatedFile(owner, entry.source.source);
      if (!validatedRoots.has(record.root)) {
        await sources.validateFileTree(owner, entry.source.source);
        validatedRoots.add(record.root);
      }
      /** Rolldown 读取真实路径，报告仍只使用 Registry 中的相对路径。 */
      const inputId = await fs.realpath(record.physicalPath);
      /** 当前 source 授权根的真实物理路径。 */
      const sourceRoot = await fs.realpath(record.root);
      sourceRoots.add(sourceRoot);
      entries.push(Object.freeze({ id: entry.id, mode: entry.mode, inputId, sourceRoot }));
    } else {
      /** 虚拟 entry 的已授权目录记录。 */
      const record = sources.authorizeDirectory(owner, entry.resolveFrom);
      if (!validatedRoots.has(record.root)) {
        await sources.validateTree(owner, entry.resolveFrom);
        validatedRoots.add(record.root);
      }
      /** 虚拟 entry 相对 import 的真实授权根。 */
      const sourceRoot = await fs.realpath(record.physicalPath);
      sourceRoots.add(sourceRoot);
      virtualSources.set(entry.inputId, Object.freeze({ code: entry.code, resolveFrom: sourceRoot }));
      entries.push(Object.freeze({ id: entry.id, mode: entry.mode, inputId: entry.inputId, sourceRoot }));
    }
  }
  for (const scope of pending.scopes) {
    /** 额外 source scope 必须同样递归拒绝 symlink 和特殊文件。 */
    const record = sources.authorizeDirectory(owner, scope);
    if (!validatedRoots.has(record.root)) {
      await sources.validateTree(owner, scope);
      validatedRoots.add(record.root);
    }
    sourceRoots.add(await fs.realpath(record.physicalPath));
  }
  return Object.freeze({
    id: pending.id,
    entries: Object.freeze(entries),
    virtualSources: new Map(virtualSources),
    sourceRoots: Object.freeze([...sourceRoots].sort(compareCodePoints)),
  });
}
