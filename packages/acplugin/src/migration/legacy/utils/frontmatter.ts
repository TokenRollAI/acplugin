import matter from 'gray-matter';

/**
 * 使用 gray-matter 容错解析旧 Markdown Frontmatter。
 *
 * @param content 包含可选 Frontmatter 的旧 Markdown。
 * @returns 调用方指定宽松类型的元数据和正文。
 */
export function parseFrontmatter<T>(content: string): { data: T; body: string } {
  /** gray-matter 的通用解析结果。 */
  const result = matter(content);
  return { data: result.data as T, body: result.content };
}

/**
 * 过滤空字段后把旧迁移元数据重新写为 Markdown Frontmatter。
 *
 * @param data 待写入的宽松元数据。
 * @param body Markdown 正文。
 * @returns 没有有效字段时的原正文，或带 Frontmatter 的 Markdown。
 */
export function stringifyFrontmatter(data: Record<string, unknown>, body: string): string {
  // undefined/null 不应在迁移生成的 YAML 中形成含义不明确的字段。
  /** 只保留具有实际旧值的 Frontmatter。 */
  const cleanData: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (value !== undefined && value !== null) {
      cleanData[key] = value;
    }
  }

  if (Object.keys(cleanData).length === 0) {
    return body;
  }

  return matter.stringify(body, cleanData);
}
