import type {
  AssetRef,
  SourceDirectoryRef,
  SourceFileRef,
} from '../contracts/services.js';
import { AssetRegistry } from './assets.js';
import { SourceRegistry } from './sources.js';

/** Extension State 支持的两个权限阶段。 */
export type ExtensionStatePhase = 'discovered' | 'validated' | 'built';

/** State snapshot 递归上下文。 */
interface SnapshotContext {
  readonly owner: string;
  readonly phase: ExtensionStatePhase;
  readonly sources: SourceRegistry;
  readonly assets: AssetRegistry;
  readonly ancestors: Set<object>;
  readonly path: string;
}

/**
 * 尝试把对象识别为当前 owner 的受权 SourceRef。
 *
 * @param value 当前对象。
 * @param context Extension snapshot 上下文。
 * @returns 有效 SourceRef 原始 identity 或 undefined。
 */
function sourceReference(value: object, context: SnapshotContext): SourceDirectoryRef | SourceFileRef | undefined {
  /** kind 只用于选择 Registry 授权分支，不能作为真实性依据。 */
  const kind = (value as { readonly kind?: unknown }).kind;
  if (context.phase === 'built') {
    if (kind === 'source-file' || kind === 'source-directory')
      throw new TypeError(`${context.path} must not contain SourceRef after build.`);
    return undefined;
  }
  try {
    if (kind === 'source-file') {
      context.sources.authorizeFile(context.owner, value as SourceFileRef);
      return value as SourceFileRef;
    }
    if (kind === 'source-directory') {
      context.sources.authorizeDirectory(context.owner, value as SourceDirectoryRef);
      return value as SourceDirectoryRef;
    }
  } catch {
    throw new TypeError(`${context.path} contains a forged or unauthorized SourceRef.`);
  }
  return undefined;
}

/**
 * 尝试把对象识别为当前 owner 的受权 AssetRef。
 *
 * @param value 当前对象。
 * @param context Extension snapshot 上下文。
 * @returns 有效 AssetRef 原始 identity 或 undefined。
 */
function assetReference(value: object, context: SnapshotContext): AssetRef | undefined {
  /** Asset kind 同样必须随后通过 WeakMap identity 校验。 */
  const kind = (value as { readonly kind?: unknown }).kind;
  if (kind !== 'source-asset' && kind !== 'generated-asset' && kind !== 'bytes-asset')
    return undefined;
  try {
    context.assets.describe(context.owner, value as AssetRef);
    return value as AssetRef;
  } catch {
    throw new TypeError(`${context.path} contains a forged or unauthorized AssetRef.`);
  }
}

/**
 * 复制普通 State 数据并保留不可伪造 ref identity。
 *
 * @param value 当前递归值。
 * @param context 当前路径和权限边界。
 * @returns 深冻普通数据或原始受权 ref。
 */
function snapshotValue(value: unknown, context: SnapshotContext): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean')
    return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value))
      throw new TypeError(`${context.path} contains a non-finite number.`);
    return value;
  }
  if (typeof value !== 'object')
    throw new TypeError(`${context.path} contains unsupported executable or symbolic data.`);
  /** SourceRef/AssetRef 必须在读取对象字段前按 Registry identity 授权。 */
  const source = sourceReference(value, context);
  if (source !== undefined)
    return source;
  /** AssetRef 保留原始不可伪造对象 identity。 */
  const asset = assetReference(value, context);
  if (asset !== undefined)
    return asset;
  if (context.ancestors.has(value))
    throw new TypeError(`${context.path} contains a cycle.`);
  context.ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      /** 稀疏或带自定义属性的数组不是无歧义 State。 */
      const fields = Object.getOwnPropertyDescriptors(value);
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.prototype.hasOwnProperty.call(value, index))
          throw new TypeError(`${context.path} contains a sparse array.`);
      }
      if (Object.keys(fields).some(field => field !== 'length' && !/^(?:0|[1-9][0-9]*)$/u.test(field)))
        throw new TypeError(`${context.path} arrays must not contain custom fields.`);
      return Object.freeze(value.map((item, index) => snapshotValue(item, { ...context, path: `${context.path}[${index}]` })));
    }
    /** class/Date/Map/Set 和自定义 prototype 全部拒绝。 */
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null)
      throw new TypeError(`${context.path} must contain only plain objects.`);
    if (Object.getOwnPropertySymbols(value).length > 0)
      throw new TypeError(`${context.path} must not contain Symbol fields.`);
    /** data descriptor 检查避免执行 getter。 */
    const fields = Object.getOwnPropertyDescriptors(value);
    /** snapshot 容器重新创建以断开调用方后续 mutation。 */
    const result: Record<string, unknown> = {};
    for (const field of Object.keys(fields).sort()) {
      /** 每个字段只读取已确认的数据描述符。 */
      const descriptor = fields[field]!;
      if (!('value' in descriptor))
        throw new TypeError(`${context.path}.${field} must be a data property.`);
      Object.defineProperty(result, field, {
        value: snapshotValue(descriptor.value, { ...context, path: `${context.path}.${field}` }),
        enumerable: true,
        configurable: false,
        writable: false,
      });
    }
    return Object.freeze(result);
  } finally {
    context.ancestors.delete(value);
  }
}

/**
 * 建立 discovered/validated/Built State 的唯一数据边界。
 *
 * @param value Extension 返回的未知值。
 * @param options 当前 Extension owner、阶段和 Registry。
 * @returns 与普通调用方容器断开、ref identity 保留的不可变 State。
 */
export function snapshotExtensionState<T>(
  value: T,
  options: {
    readonly owner: string;
    readonly phase: ExtensionStatePhase;
    readonly sources: SourceRegistry;
    readonly assets: AssetRegistry;
  },
): Readonly<T> {
  return snapshotValue(value, {
    ...options,
    ancestors: new Set<object>(),
    path: `Extension ${options.phase} state`,
  }) as Readonly<T>;
}
