import { stringify } from 'yaml';
import { sortObject } from './json.js';

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
 * @returns 可直接写入 Asset 的完整 Markdown 文本。
 */
export function markdownWithFrontmatter(frontmatter: Record<string, unknown>, body: string): string {
  return `---\n${stableYaml(frontmatter)}\n---\n${body.trim()}\n`;
}
