export interface ExtensionIssue {
  path: readonly (string | number)[];
  message: string;
}

const CANONICAL_KEYS = new Set([
  'name', 'version', 'description', 'displayname', 'body', 'prompt', 'instructions',
  'commands', 'skills', 'agents', 'hooks', 'mcp', 'mcpservers', 'manifest',
]);

export function extensionIssues(
  value: unknown,
  path: readonly (string | number)[] = [],
  seen = new WeakSet<object>(),
): ExtensionIssue[] {
  if (value === null || typeof value === 'string' || typeof value === 'boolean')
    return [];
  if (typeof value === 'number')
    return Number.isFinite(value) ? [] : [{ path, message: 'Extension numbers must be finite.' }];
  if (Array.isArray(value)) {
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
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== null && prototype !== Object.prototype)
    return [{ path, message: 'Extension objects must be plain JSON mappings.' }];

  const issues: ExtensionIssue[] = [];
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const childPath = [...path, key];
    if (CANONICAL_KEYS.has(key.toLowerCase())) {
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
