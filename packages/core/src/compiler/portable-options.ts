import type { PortableNodeCompileOptions } from '../kernel-types.js';
import { dataProperties } from './job-normalizer.js';

/** 运行时校验并快照后的 portable-node 参数。 */
export interface NormalizedPortableOptions {
  readonly resolve?: {
    readonly conditionNames?: readonly string[];
    readonly extensions?: readonly string[];
    readonly mainFields?: readonly string[];
    readonly mainFiles?: readonly string[];
  };
  readonly transform?: {
    readonly define?: Readonly<Record<string, string>>;
    readonly dropLabels?: readonly string[];
    readonly jsx?: false | 'react' | 'react-jsx' | 'preserve';
  };
  readonly treeshake?: boolean;
}

/**
 * 复制只包含字符串的数组。
 *
 * @param value 调用方字段值。
 * @param label 稳定诊断路径。
 * @returns 与调用方断开引用的冻结数组。
 */
function stringArray(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value))
    throw new TypeError(`${label} must be an array of non-empty strings.`);
  /** 数组的 index 读取后立即复制，随后验证每项。 */
  const copy = [...value];
  if (copy.some(item => typeof item !== 'string' || item.length === 0))
    throw new TypeError(`${label} must be an array of non-empty strings.`);
  if (new Set(copy).size !== copy.length)
    throw new TypeError(`${label} must not contain duplicates.`);
  return Object.freeze(copy as string[]);
}

/**
 * 校验并复制 portable-node options 的安全 JSON 子集。
 *
 * @param value 调用方 options。
 * @returns 可直接映射到固定 Rolldown preset 的冻结参数。
 */
export function normalizePortableOptions(value: unknown): NormalizedPortableOptions {
  /** portable options 省略时等价于空对象。 */
  const options = dataProperties(value, 'Portable compile options', true);
  for (const field of Object.keys(options)) {
    if (!new Set(['resolve', 'transform', 'treeshake']).has(field))
      throw new TypeError(`Portable compile options.${field} is unknown.`);
  }
  /** 可选 resolve 字段只允许四组稳定字符串列表。 */
  let resolve: NormalizedPortableOptions['resolve'];
  if (options.resolve !== undefined) {
    /** resolve subset 的完整 data property 集。 */
    const fields = dataProperties(options.resolve.value, 'Portable compile options.resolve');
    for (const field of Object.keys(fields)) {
      if (!new Set(['conditionNames', 'extensions', 'mainFields', 'mainFiles']).has(field))
        throw new TypeError(`Portable compile options.resolve.${field} is unknown.`);
    }
    resolve = Object.freeze(Object.fromEntries(Object.entries(fields).map(([field, descriptor]) => [
      field,
      stringArray(descriptor.value, `Portable compile options.resolve.${field}`),
    ])));
  }
  /** 可选 transform 字段不接受 Plugin、inject、alias 或函数。 */
  let transform: NormalizedPortableOptions['transform'];
  if (options.transform !== undefined) {
    /** transform subset 的完整 data property 集。 */
    const fields = dataProperties(options.transform.value, 'Portable compile options.transform');
    for (const field of Object.keys(fields)) {
      if (!new Set(['define', 'dropLabels', 'jsx']).has(field))
        throw new TypeError(`Portable compile options.transform.${field} is unknown.`);
    }
    /** define 必须是 string-to-string plain data object。 */
    let define: Readonly<Record<string, string>> | undefined;
    if (fields.define !== undefined) {
      /** define 的完整 string-to-string data property 集。 */
      const definitions = dataProperties(fields.define.value, 'Portable compile options.transform.define');
      /** 逐 key 排序保证传入 Engine 的结构顺序稳定。 */
      const entries = Object.keys(definitions).sort().map((key) => {
        if (key.length === 0 || typeof definitions[key]!.value !== 'string')
          throw new TypeError('Portable compile options.transform.define must map non-empty keys to strings.');
        return [key, definitions[key]!.value] as const;
      });
      define = Object.freeze(Object.fromEntries(entries));
    }
    /** JSX 只开放 Rolldown 精确类型中的三个稳定模式和显式禁用。 */
    const jsx = fields.jsx?.value;
    if (jsx !== undefined && jsx !== false && jsx !== 'react' && jsx !== 'react-jsx' && jsx !== 'preserve')
      throw new TypeError('Portable compile options.transform.jsx is invalid.');
    transform = Object.freeze({
      ...(define === undefined ? {} : { define }),
      ...(fields.dropLabels === undefined ? {} : { dropLabels: stringArray(fields.dropLabels.value, 'Portable compile options.transform.dropLabels') }),
      ...(jsx === undefined ? {} : { jsx }),
    });
  }
  /** 顶层布尔/枚举参数使用 exact runtime union。 */
  const treeshake = options.treeshake?.value;
  if (treeshake !== undefined && typeof treeshake !== 'boolean')
    throw new TypeError('Portable compile options.treeshake must be boolean.');
  return Object.freeze({
    ...(resolve === undefined ? {} : { resolve }),
    ...(transform === undefined ? {} : { transform }),
    ...(treeshake === undefined ? {} : { treeshake }),
  }) satisfies PortableNodeCompileOptions;
}
