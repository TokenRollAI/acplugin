import * as fs from 'fs';
import * as path from 'path';

export function ensureDir(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true });
}

export function writeFile(filePath: string, content: string): void {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, content, 'utf-8');
}

export function readFile(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
}

export function fileExists(filePath: string): boolean {
  return fs.existsSync(filePath);
}

export function listFiles(dir: string, pattern?: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const entries = fs.readdirSync(dir, { withFileTypes: true, recursive: false });
  return entries
    .filter(e => e.isFile() && (!pattern || e.name.match(new RegExp(pattern))))
    .map(e => path.join(dir, e.name));
}

export function listDirs(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  return entries
    .filter(e => e.isDirectory())
    .map(e => path.join(dir, e.name));
}

export function listFilesRecursive(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const results: string[] = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isFile()) {
      results.push(fullPath);
    } else if (entry.isDirectory()) {
      results.push(...listFilesRecursive(fullPath));
    }
  }
  return results;
}
