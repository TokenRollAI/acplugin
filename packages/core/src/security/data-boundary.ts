/** 安全边界已验证 data property 的 descriptor 形状。 */
export type DataPropertyDescriptor = PropertyDescriptor & { readonly value: unknown };

/**
 * 验证 Integration 返回的是仅含 data property 的普通对象。
 *
 * @param value 未受信任对象。
 * @param allowed 允许出现的完整字段集合。
 * @param label 稳定诊断标签。
 * @returns 不会在后续读取时执行 getter 的字段 descriptor。
 */
export function dataObjectFields(
  value: unknown,
  allowed: ReadonlySet<string>,
  label: string,
): Readonly<Record<string, DataPropertyDescriptor>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new TypeError(`${label} must be a plain object.`);
  /** null-prototype records 与 object literal 都属于无行为数据容器。 */
  const prototype = Object.getPrototypeOf(value);
  if ((prototype !== Object.prototype && prototype !== null) || Object.getOwnPropertySymbols(value).length > 0)
    throw new TypeError(`${label} must be a plain object without Symbol fields.`);
  /** descriptor 边界保证校验本身不会执行 Integration getter。 */
  const descriptors = Object.getOwnPropertyDescriptors(value) as Record<string, PropertyDescriptor>;
  for (const [field, descriptor] of Object.entries(descriptors)) {
    if (!allowed.has(field))
      throw new TypeError(`${label} contains unknown field "${field}".`);
    if (!('value' in descriptor) || descriptor.enumerable !== true)
      throw new TypeError(`${label}.${field} must be an enumerable data property.`);
  }
  return descriptors as Readonly<Record<string, DataPropertyDescriptor>>;
}

/**
 * 验证 Integration 数组稠密、无自定义字段且不会通过 getter 取值。
 *
 * @param value 未受信任数组。
 * @param label 稳定诊断标签。
 * @returns 与原数组容器断开的浅层冻结元素快照。
 */
export function dataArrayItems(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype
    || Object.getOwnPropertySymbols(value).length > 0) {
    throw new TypeError(`${label} must be an array without Symbol fields.`);
  }
  /** length 与每个 index 都从 descriptor 读取，避免稀疏数组和 accessor。 */
  const descriptors = Object.getOwnPropertyDescriptors(value) as Record<string, PropertyDescriptor>;
  /** 原始 length descriptor 决定精确遍历边界。 */
  const length = descriptors.length?.value;
  if (!Number.isSafeInteger(length) || length < 0)
    throw new TypeError(`${label} has an invalid length.`);
  /** 新数组与调用方容器断开。 */
  const result: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    /** 单个 index 必须是显式可枚举 data property。 */
    const descriptor = descriptors[String(index)];
    if (descriptor === undefined || !('value' in descriptor) || descriptor.enumerable !== true)
      throw new TypeError(`${label} must be dense and contain only data properties.`);
    result.push(descriptor.value);
  }
  if (Object.keys(descriptors).some(field => field !== 'length' && !/^(?:0|[1-9][0-9]*)$/u.test(field)))
    throw new TypeError(`${label} must not contain custom fields.`);
  return Object.freeze(result);
}
