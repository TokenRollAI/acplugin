import matter from 'gray-matter';

export function parseFrontmatter<T>(content: string): { data: T; body: string } {
  const result = matter(content);
  return { data: result.data as T, body: result.content };
}

export function stringifyFrontmatter(data: Record<string, unknown>, body: string): string {
  // Filter out undefined/null values
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
