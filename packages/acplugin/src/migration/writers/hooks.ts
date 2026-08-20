/** Legacy Hook 引用的隔离保留逻辑。 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Hooks } from '../legacy/types.js';
import { compareCodeUnits } from '../ids.js';
import type { MigrationItem } from '../types.js';
import { migrationItem } from './shared.js';

/**
 * 从旧 Hook 命令中提取相对于 Plugin/Project 根目录的文件引用候选。
 *
 * @param hooks Legacy Scanner 读取的原始 Hook 配置。
 * @returns 去重并稳定排序的相对路径。
 */
export function hookReferenceCandidates(hooks: Hooks): string[] {
  /** 从环境变量根路径和 `./` 语法提取的引用集合。 */
  const references = new Set<string>();
  for (const matchers of Object.values(hooks)) {
    for (const matcher of matchers) {
      for (const hook of matcher.hooks) {
        if (!hook.command)
          continue;
        for (const match of hook.command.matchAll(/(?:\$\{(?:CLAUDE_PLUGIN_ROOT|CLAUDE_PROJECT_DIR)\}|\$(?:CLAUDE_PLUGIN_ROOT|CLAUDE_PROJECT_DIR))\/([^\s"'`;|&]+)/g))
          references.add(match[1]!);
        for (const match of hook.command.matchAll(/(?:^|[\s"'=])\.\/([^\s"'`;|&]+)/g))
          references.add(match[1]!);
      }
    }
  }
  return [...references].sort(compareCodeUnits);
}

/**
 * 递归保留旧 Hook 引用文件，但不把未经类型化迁移的代码加入可发布源码。
 *
 * @param sourceRoot 旧工程根目录和路径信任边界。
 * @param relativePath Hook 命令提取出的相对路径。
 * @param outputRoot 新规范工程的阶段目录。
 * @param items 共享迁移报告条目数组。
 */
export async function copyHookReference(
  sourceRoot: string,
  relativePath: string,
  outputRoot: string,
  items: MigrationItem[],
): Promise<void> {
  /** 解析后的 Hook 引用绝对路径。 */
  const source = path.resolve(sourceRoot, relativePath);
  /** 用于阻止目录逃逸并生成报告的来源相对路径。 */
  const relation = path.relative(sourceRoot, source);
  if (relation === '..' || relation.startsWith(`..${path.sep}`) || path.isAbsolute(relation)) {
    /** 越界引用只保留脱敏字段结论，不把绝对解析路径写入报告。 */
    const safeSource = relativePath.split(path.sep).join('/');
    items.push(migrationItem({ kind: 'hook-file', id: safeSource }, [{
      field: 'content', source: safeSource, outcome: 'unmapped',
      reason: 'Referenced Hook file escapes the source project and was not copied.',
    }]));
    return;
  }
  /** 引用文件的 lstat 元数据，用于拒绝符号链接。 */
  let stat: import('node:fs').Stats;
  try {
    stat = await fs.lstat(source);
  } catch {
    /** 不存在的引用仍用工程相对路径进入字段报告。 */
    const normalized = relation.split(path.sep).join('/');
    items.push(migrationItem({ kind: 'hook-file', id: relativePath, source: normalized }, [{
      field: 'content', source: normalized, outcome: 'unmapped',
      reason: 'Referenced Hook file does not exist and requires manual recovery.',
    }]));
    return;
  }
  if (stat.isSymbolicLink()) {
    /** 符号链接不解引用，只报告链接自身的相对位置。 */
    const normalized = relation.split(path.sep).join('/');
    items.push(migrationItem({ kind: 'hook-file', id: relativePath, source: normalized }, [{
      field: 'content', source: normalized, outcome: 'unmapped',
      reason: 'Referenced Hook symlinks are not copied.',
    }]));
    return;
  }
  if (stat.isDirectory()) {
    /** 按名称稳定递归的目录项。 */
    const entries = await fs.readdir(source, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => compareCodeUnits(a.name, b.name)))
      await copyHookReference(sourceRoot, path.join(relativePath, entry.name), outputRoot, items);
    return;
  }
  if (!stat.isFile())
    return;
  /** 报告和未映射目录使用的 POSIX 相对路径。 */
  const normalized = relation.split(path.sep).join('/');
  /** 与可发布源码隔离的 Hook 文件目标路径。 */
  const destination = `.acplugin-migration/unmapped/hook-files/${normalized}`;
  /** 未映射文件的绝对写入路径。 */
  const output = path.join(outputRoot, destination);
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.copyFile(source, output);
  items.push(migrationItem({ kind: 'hook-file', id: normalized, source: normalized, destination }, [{
    field: 'content', source: normalized, destination, outcome: 'unmapped',
    reason: 'Referenced Hook implementation was preserved for manual typed migration.',
  }]));
}
