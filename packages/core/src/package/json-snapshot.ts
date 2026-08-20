import type {
  DocumentFieldPath,
  JsonObject,
  JsonValue,
} from '../contracts/common.js';
import { snapshotJson } from '../security/json-snapshot.js';
import { compareCodePoints } from '../security/path-policy.js';

/** Package 领域沿用唯一的 Core strict JSON snapshot 实现。 */
export { snapshotJson };

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
