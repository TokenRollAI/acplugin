import { stringify } from 'yaml';

/**
 * 递归复制可序列化值，并按键名排序对象、移除值为 undefined 的字段。
 *
 * 数组顺序属于业务语义，因此只处理数组元素而不会重新排序。
 *
 * @param value 需要进入 JSON、YAML 或 frontmatter 的数据。
 * @returns 具有确定对象键顺序的等价值。
 */
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

/**
 * 将值序列化为适合写入 Artifact 的确定性格式化 JSON。
 *
 * @param value 需要序列化的数据。
 * @returns 使用两个空格缩进且以换行结尾的 JSON 文本。
 */
export function stableJson(value: unknown): string {
  return `${JSON.stringify(sortObject(value), null, 2)}\n`;
}

/**
 * 将值序列化为不受对象插入顺序影响的 YAML。
 *
 * @param value 需要序列化的数据。
 * @returns 不带尾随换行、且不主动折叠长行的 YAML 文本。
 */
export function stableYaml(value: unknown): string {
  return stringify(sortObject(value), { lineWidth: 0 }).trimEnd();
}

/**
 * 组合 YAML frontmatter 与 Markdown 正文，建立统一的空白和结尾换行约定。
 *
 * @param frontmatter 文档头部的结构化元数据。
 * @param body Markdown 正文。
 * @returns 可直接写入 Artifact 的完整 Markdown 文本。
 */
export function markdownWithFrontmatter(frontmatter: Record<string, unknown>, body: string): string {
  return `---\n${stableYaml(frontmatter)}\n---\n${body.trim()}\n`;
}
