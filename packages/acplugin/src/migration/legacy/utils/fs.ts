import * as fs from 'fs';
import * as path from 'path';

/**
 * 递归创建 Legacy Scanner 或迁移写入所需目录。
 *
 * @param dirPath 目标目录路径。
 */
export function ensureDir(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true });
}

/**
 * 创建父目录后同步写入 UTF-8 文本。
 *
 * @param filePath 目标文件路径。
 * @param content 文本内容。
 */
export function writeFile(filePath: string, content: string): void {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, content, 'utf-8');
}

/**
 * 容错同步读取旧文本文件。
 *
 * @param filePath 旧资源路径。
 * @returns UTF-8 内容；不存在或不可读时返回 null。
 */
export function readFile(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
}

/**
 * 判断 Legacy Scanner 候选路径是否存在。
 *
 * @param filePath 待检查路径。
 * @returns 路径存在时返回 true。
 */
export function fileExists(filePath: string): boolean {
  return fs.existsSync(filePath);
}

/**
 * 列出目录一级普通文件，并可按正则文本过滤名称。
 *
 * @param dir 旧资源目录。
 * @param pattern 可选的文件名正则源码。
 * @returns 一级文件完整路径列表。
 */
export function listFiles(dir: string, pattern?: string): string[] {
  if (!fs.existsSync(dir)) return [];
  /** 当前目录的一级目录项。 */
  const entries = fs.readdirSync(dir, { withFileTypes: true, recursive: false });
  return entries
    .filter(e => e.isFile() && (!pattern || e.name.match(new RegExp(pattern))))
    .map(e => path.join(dir, e.name));
}

/**
 * 列出目录一级真实子目录，不跟随符号链接。
 *
 * @param dir 旧资源目录。
 * @returns 一级子目录完整路径列表。
 */
export function listDirs(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  /** 当前目录的一级目录项。 */
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  return entries
    .filter(e => e.isDirectory())
    .map(e => path.join(dir, e.name));
}

/**
 * 递归列出目录中的普通文件，不跟随符号链接目录。
 *
 * @param dir 旧资源根目录。
 * @returns 深度优先发现的完整文件路径列表。
 */
export function listFilesRecursive(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  /** 当前递归子树累计发现的普通文件。 */
  const results: string[] = [];
  /** 当前目录的一级目录项。 */
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    /** 当前目录项的完整路径。 */
    const fullPath = path.join(dir, entry.name);
    if (entry.isFile()) {
      results.push(fullPath);
    } else if (entry.isDirectory()) {
      results.push(...listFilesRecursive(fullPath));
    }
  }
  return results;
}
