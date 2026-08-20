import { promises as fs } from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import { compareCodeUnits } from '../ids.js';
import type {
  MigrationFieldDraft,
  MigrationFieldOutcome,
  MigrationItem,
  MigrationOutcome,
} from '../types.js';

/** 字段结论从完整保真到无法映射的严重度顺序。 */
const FIELD_OUTCOME_RANK: Readonly<Record<MigrationFieldOutcome, number>> = {
  mapped: 0,
  degraded: 1,
  unmapped: 2,
};

/** 记录一个已发现字段的脱敏迁移结论。 */
export function reportField(
  fields: MigrationFieldDraft[],
  field: string,
  source: string,
  outcome: MigrationFieldOutcome,
  reason: string,
  destination?: string,
): void {
  fields.push({ field, source, outcome, reason, ...(destination === undefined ? {} : { destination }) });
}

/** 按字段最差结论创建唯一的资源级迁移记录。 */
export function migrationItem(
  resource: Omit<MigrationItem, 'outcome' | 'fields'>,
  fields: readonly MigrationFieldDraft[],
): MigrationItem {
  /** 未输出文件的聚合记录统一指向人工可审查的迁移报告。 */
  const destination = resource.destination ?? '.acplugin-migration/report.json';
  /** 字段最差结果决定资源总体，不允许 unmapped 被压低成 degraded。 */
  const worst = fields.reduce<MigrationFieldOutcome>(
    (current, field) => FIELD_OUTCOME_RANK[field.outcome] > FIELD_OUTCOME_RANK[current] ? field.outcome : current,
    'mapped',
  );
  /** 字段 mapped 对应资源 migrated，其余名称在两个协议中一致。 */
  const outcome: MigrationOutcome = worst === 'mapped' ? 'migrated' : worst;
  return {
    ...resource,
    outcome,
    fields: Object.freeze(fields.map(field => Object.freeze({ ...field, destination: field.destination ?? destination }))),
  };
}

/** 判断路径是否可访问。 */
export async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

/** 确保父目录存在后写入迁移文本文件。 */
export async function copyText(destination: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.writeFile(destination, content);
}

/** 为 Migration 自己生成的 Frontmatter 递归固定对象键顺序。 */
function sortFrontmatter(value: unknown): unknown {
  if (Array.isArray(value))
    return value.map(sortFrontmatter);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(entry => entry[1] !== undefined)
      .sort(([left], [right]) => compareCodeUnits(left, right))
      .map(([key, child]) => [key, sortFrontmatter(child)]));
  }
  return value;
}

/** 组合确定性 YAML Frontmatter 与规范 Markdown 正文。 */
export function markdownWithFrontmatter(frontmatter: Record<string, unknown>, body: string): string {
  return matter.stringify(body.trim(), sortFrontmatter(frontmatter) as Record<string, unknown>);
}

/** 创建父目录后按原始字节复制可信来源文件。 */
export async function copyBytes(source: string, destination: string): Promise<void> {
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.copyFile(source, destination);
}

/** 把无法安全自动迁移的文本保存在专用未映射目录。 */
export async function unmapped(
  outputRoot: string,
  category: string,
  filename: string,
  content: string,
): Promise<string> {
  /** 与可发布源码隔离的未映射目标路径。 */
  const destination = `.acplugin-migration/unmapped/${category}/${filename}`;
  await copyText(path.join(outputRoot, destination), content);
  return destination;
}
