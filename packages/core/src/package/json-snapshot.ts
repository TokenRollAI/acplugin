import type { DocumentFieldPath, JsonObject, JsonValue } from '../kernel-types.js';
import { dataArrayItems, dataObjectFields } from '../kernel/data-boundary.js';
import { compareCodePoints } from '../kernel/path-policy.js';

/** JSON snapshot 递归时携带的路径和祖先集合。 */
interface SnapshotState {
  readonly path: string;
  readonly ancestors: Set<object>;
}

/**
 * 复制严格 JSON 值并拒绝 getter、Symbol、稀疏数组和循环。
 *
 * @param value Integration 返回的未知值。
 * @param state 当前递归路径与祖先身份。
 * @returns 与调用方容器断开的深度冻结 JSON。
 */
function snapshot(value: unknown, state: SnapshotState): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean')
    return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value))
      throw new TypeError(`${state.path} must contain only finite JSON numbers.`);
    return value;
  }
  if (typeof value !== 'object')
    throw new TypeError(`${state.path} must contain only JSON values.`);
  if (state.ancestors.has(value))
    throw new TypeError(`${state.path} must not contain cycles.`);
  state.ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      /** 数组先经过统一 data boundary，再递归复制每个元素。 */
      const items = dataArrayItems(value, state.path);
      return Object.freeze(items.map((item, index) => snapshot(item, {
        ancestors: state.ancestors,
        path: `${state.path}[${index}]`,
      })));
    }
    /** JSON object 允许任意字符串字段，但仍统一拒绝行为型容器。 */
    const ownFields = Object.getOwnPropertyNames(value);
    /** 任意字段集合仍通过统一 descriptor boundary。 */
    const fields = dataObjectFields(value, new Set(ownFields), state.path);
    /** 新对象不保留调用方 prototype 或 descriptor 可变性。 */
    const result: Record<string, JsonValue> = {};
    for (const field of Object.keys(fields).sort(compareCodePoints)) {
      /** 每个 JSON 字段必须是显式 data property。 */
      const descriptor = fields[field]!;
      if (!('value' in descriptor))
        throw new TypeError(`${state.path}.${field} must be a data property.`);
      Object.defineProperty(result, field, {
        value: snapshot(descriptor.value, { ancestors: state.ancestors, path: `${state.path}.${field}` }),
        enumerable: true,
        configurable: false,
        writable: false,
      });
    }
    return Object.freeze(result);
  } finally {
    state.ancestors.delete(value);
  }
}

/**
 * 建立可进入 Document、Contribution 或报告的严格 JSON snapshot。
 *
 * @param value 外部 JSON 候选。
 * @param label 根路径诊断标签。
 * @returns 深度冻结且键序稳定的 JSON。
 */
export function snapshotJson(value: unknown, label = 'JSON value'): JsonValue {
  return snapshot(value, { path: label, ancestors: new Set<object>() });
}

/**
 * 验证并复制非空 Document 字段路径。
 *
 * @param value 未受信任路径。
 * @param label 诊断标签。
 * @returns 不含控制字符且冻结的非空字段 tuple。
 */
export function snapshotFieldPath(value: unknown, label = 'Document field path'): DocumentFieldPath {
  if (!Array.isArray(value) || value.length === 0
    || value.some(segment => typeof segment !== 'string' || segment.length === 0 || /[\0\r\n\t]/u.test(segment))) {
    throw new TypeError(`${label} must be a non-empty array of stable field names.`);
  }
  return Object.freeze([...value]) as unknown as DocumentFieldPath;
}

/** @returns 字段路径不会因分隔字符内容产生歧义的内部键。 */
export function documentFieldKey(path: DocumentFieldPath): string {
  return JSON.stringify(path);
}

/**
 * 检查字段父链存在且最终字段尚未出现。
 *
 * @param value 当前 Document 根值。
 * @param fieldPath 待贡献的精确字段路径。
 * @returns 当前路径是 add-only 空位时为 true。
 */
export function documentFieldAvailable(value: JsonValue, fieldPath: DocumentFieldPath): boolean {
  /** current 沿既有父链逐段进入。 */
  let current: JsonValue = value;
  for (const segment of fieldPath.slice(0, -1)) {
    if (current === null || typeof current !== 'object' || Array.isArray(current) || !Object.hasOwn(current, segment))
      return false;
    current = (current as JsonObject)[segment]!;
  }
  if (current === null || typeof current !== 'object' || Array.isArray(current))
    return false;
  return !Object.hasOwn(current, fieldPath.at(-1)!);
}

/**
 * 通过逐层复制向不可变 JSON 新增一个精确字段。
 *
 * @param value 已证明字段空缺的 Document 值。
 * @param fieldPath 精确字段路径。
 * @param addition 已冻结的新增 JSON。
 * @returns 保持全部原字段且新增目标字段的冻结值。
 */
export function addDocumentField(value: JsonValue, fieldPath: DocumentFieldPath, addition: JsonValue): JsonValue {
  /** 当前层必然是字段父链上的 JSON object。 */
  const object = value as JsonObject;
  /** head 是当前层字段，tail 是剩余路径。 */
  const [head, ...tail] = fieldPath;
  /** 原字段先映射到新容器，路径字段递归替换为复制结果。 */
  const entries: [string, JsonValue][] = Object.entries(object).map(([field, child]) => [
    field,
    field === head && tail.length > 0 ? addDocumentField(child, tail as unknown as DocumentFieldPath, addition) : child,
  ]);
  if (tail.length === 0)
    entries.push([head, addition]);
  /** 每层对象重新按 code point 排序并定义只读 data property。 */
  const result: Record<string, JsonValue> = {};
  for (const [field, child] of entries.sort(([left], [right]) => compareCodePoints(left, right)))
    Object.defineProperty(result, field, { value: child, enumerable: true, configurable: false, writable: false });
  return Object.freeze(result);
}
