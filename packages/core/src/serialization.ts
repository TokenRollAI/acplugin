import { stringify } from 'yaml';

export function sortObject(value: unknown): unknown {
  if (Array.isArray(value))
    return value.map(sortObject);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([a], [b]) => a.localeCompare(b, 'en'))
      .map(([key, child]) => [key, sortObject(child)]));
  }
  return value;
}

export function stableJson(value: unknown): string {
  return `${JSON.stringify(sortObject(value), null, 2)}\n`;
}

export function stableYaml(value: unknown): string {
  return stringify(sortObject(value), { lineWidth: 0 }).trimEnd();
}

export function markdownWithFrontmatter(frontmatter: Record<string, unknown>, body: string): string {
  return `---\n${stableYaml(frontmatter)}\n---\n${body.trim()}\n`;
}
