/** 描述扩展数据中一项不符合可序列化或语义隔离约束的问题。 */
export interface ExtensionIssue {
  /** 从扩展根值到问题字段的字符串键或数组下标路径。 */
  path: readonly (string | number)[];
  /** 面向配置作者的问题说明。 */
  message: string;
}

/**
 * Core 已拥有语义的保留字段名集合。
 *
 * 扩展字段会按不区分大小写的方式检查，防止 Module 通过别名覆盖标准 Plugin 契约。
 */
const CANONICAL_KEYS = new Set([
  'name', 'version', 'description', 'displayname', 'body', 'prompt', 'instructions',
  'commands', 'skills', 'agents', 'hooks', 'mcp', 'mcpservers', 'manifest',
]);

/**
 * 递归验证扩展值是否为确定性 JSON 数据，并与 Core 标准字段保持语义隔离。
 *
 * @param value 当前需要验证的扩展值或递归子值。
 * @param path 当前值相对于扩展根节点的位置。
 * @param seen 已访问对象集合，用于拒绝循环引用和重复对象引用。
 * @returns 当前子树中发现的全部问题，不会在首个错误处提前结束。
 */
export function extensionIssues(
  value: unknown,
  path: readonly (string | number)[] = [],
  seen: WeakSet<object> = new WeakSet<object>(),
): ExtensionIssue[] {
  if (value === null || typeof value === 'string' || typeof value === 'boolean')
    return [];
  if (typeof value === 'number')
    return Number.isFinite(value) ? [] : [{ path, message: 'Extension numbers must be finite.' }];
  if (Array.isArray(value)) {
    // 扩展最终会进入稳定 JSON/YAML；引用图必须退化为没有循环或共享节点的值树。
    if (seen.has(value))
      return [{ path, message: 'Extension values cannot contain cycles.' }];
    seen.add(value);
    return value.flatMap((item, index) => extensionIssues(item, [...path, index], seen));
  }
  if (typeof value !== 'object')
    return [{ path, message: 'Extension values must be deterministic JSON data.' }];
  if (seen.has(value))
    return [{ path, message: 'Extension values cannot contain cycles.' }];
  seen.add(value);
  /** 当前映射值的原型，用于排除 Date、Map 和自定义类实例。 */
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== null && prototype !== Object.prototype)
    return [{ path, message: 'Extension objects must be plain JSON mappings.' }];

  /** 当前对象及所有后代累计产生的问题。 */
  const issues: ExtensionIssue[] = [];
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    /** 当前字段对应的完整问题路径。 */
    const childPath = [...path, key];
    if (CANONICAL_KEYS.has(key.toLowerCase())) {
      // Canonical 数据只能通过正式配置和 Component 契约进入，扩展不能创建第二套含义。
      issues.push({
        path: childPath,
        message: `Extension field "${key}" duplicates canonical plugin semantics.`,
      });
      continue;
    }
    issues.push(...extensionIssues(child, childPath, seen));
  }
  return issues;
}
