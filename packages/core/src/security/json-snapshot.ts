import type { JsonValue } from '../contracts/common.js';
import { compareCodeUnits } from '../serialization/json.js';

/** 递归 JSON snapshot 的祖先集合与稳定字段路径。 */
interface JsonSnapshotState {
  readonly ancestors: Set<object>;
  readonly path: string;
}

/**
 * 返回不执行 getter 的自有字段描述符，并拒绝 Symbol 字段。
 *
 * @param value 当前 JSON 容器。
 * @param path 稳定诊断路径。
 * @returns 当前容器的完整字符串字段描述符。
 */
function ownDescriptors(value: object, path: string): Readonly<Record<string, PropertyDescriptor>> {
  if (Object.getOwnPropertySymbols(value).length > 0)
    throw new TypeError(`${path} must not contain Symbol properties.`);
  return Object.getOwnPropertyDescriptors(value);
}

/**
 * 读取一个可枚举 data property，避免 snapshot 执行作者行为。
 *
 * @param descriptor 待验证字段描述符。
 * @param path 稳定诊断路径。
 * @returns 字段保存的原始值。
 */
function dataPropertyValue(descriptor: PropertyDescriptor | undefined, path: string): unknown {
  if (descriptor === undefined || !('value' in descriptor) || descriptor.enumerable !== true)
    throw new TypeError(`${path} must be an enumerable data property.`);
  return descriptor.value;
}

/**
 * 在普通对象上安全定义 JSON 字段，包括不会触发原型 setter 的 `__proto__`。
 *
 * @param target snapshot 输出对象。
 * @param key 当前字段名。
 * @param value 已完成递归 snapshot 的字段值。
 */
function defineJsonField(target: Record<string, JsonValue>, key: string, value: JsonValue): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    configurable: false,
    writable: false,
  });
}

/**
 * 递归复制一个严格 JSON 值并冻结全部容器。
 *
 * @param value 当前未知输入。
 * @param state 当前祖先集合与诊断路径。
 * @returns 与输入 identity 隔离的 JSON snapshot。
 */
function snapshotValue(value: unknown, state: JsonSnapshotState): JsonValue {
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
      if (Object.getPrototypeOf(value) !== Array.prototype)
        throw new TypeError(`${state.path} must be a plain array.`);
      /** length 是数组唯一允许的不可枚举自有字段。 */
      const descriptors = ownDescriptors(value, state.path);
      /** 数组必须只拥有 length 与范围内的十进制索引。 */
      for (const field of Object.keys(descriptors)) {
        if (field === 'length')
          continue;
        if (!/^(?:0|[1-9][0-9]*)$/u.test(field) || Number(field) >= value.length)
          throw new TypeError(`${state.path} arrays must not contain custom properties.`);
      }
      /** 逐索引读取 descriptor，既拒绝稀疏数组也不执行 getter。 */
      const result: JsonValue[] = [];
      for (let index = 0; index < value.length; index += 1) {
        /** 缺失 index 使用明确 sparse 诊断，其余 descriptor 仍走 data property 验证。 */
        const descriptor = descriptors[String(index)];
        if (descriptor === undefined)
          throw new TypeError(`${state.path} must not contain sparse arrays.`);
        result.push(snapshotValue(dataPropertyValue(descriptor, `${state.path}[${index}]`), {
          ancestors: state.ancestors,
          path: `${state.path}[${index}]`,
        }));
      }
      return Object.freeze(result);
    }

    /** JSON object 只接受 object literal 与 null-prototype record。 */
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null)
      throw new TypeError(`${state.path} must be a plain object.`);
    /** 字段按 code unit 排序并逐个验证为可枚举 data property。 */
    const descriptors = ownDescriptors(value, state.path);
    /** 输出使用普通对象；defineProperty 避免特殊键触发 Object.prototype setter。 */
    const result: Record<string, JsonValue> = {};
    for (const field of Object.keys(descriptors).sort(compareCodeUnits)) {
      /** 当前字段的稳定诊断路径不读取其值。 */
      const fieldPath = `${state.path}.${field}`;
      defineJsonField(result, field, snapshotValue(dataPropertyValue(descriptors[field], fieldPath), {
        ancestors: state.ancestors,
        path: fieldPath,
      }));
    }
    return Object.freeze(result);
  } finally {
    state.ancestors.delete(value);
  }
}

/**
 * 将未知输入规范化为与调用方 identity 隔离的严格 JSON snapshot。
 *
 * 该函数不调用 getter、iterator、toJSON 或其他作者行为，并递归冻结结果。
 *
 * @param value 待验证和复制的未知输入。
 * @param label 稳定诊断中的根对象名称。
 * @returns 按对象键稳定排序的深冻结 JSON 值。
 */
export function snapshotJson(value: unknown, label: string): JsonValue {
  if (typeof label !== 'string' || label.length === 0)
    throw new TypeError('JSON snapshot label must be a non-empty string.');
  return snapshotValue(value, { ancestors: new Set<object>(), path: label });
}
