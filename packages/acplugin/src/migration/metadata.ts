/** Legacy 元数据到 canonical PluginMetadata 的逐字段规划。 */
import path from 'node:path';
import { input } from '@inquirer/prompts';
import semver from 'semver';
import parseSpdxExpression from 'spdx-expression-parse';
import type { PluginMetadata } from '@acplugin/core';
import type { PluginScanResult, ScanResult } from './legacy/types.js';
import { compareCodeUnits, ID_PATTERN, safeId } from './ids.js';
import type { MigrationFieldDraft, MigrationItem, MigrationOptions } from './types.js';
import { migrationItem, reportField } from './writers/shared.js';

/** Plugin 作者邮件与 Core 配置保持一致的保守结构规则。 */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** 旧 JSON 中可枚举且不是数组的对象形态。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * 按 Core 规则把非空字符串去除首尾空白。
 *
 * @param value 未经 Schema 验证的旧字段值。
 * @returns 可进入规范配置的字符串；类型或内容无效时返回 undefined。
 */
function normalizedText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

/**
 * 使用与 Core 一致的绝对 HTTP(S) URL 边界。
 *
 * @param value 已去除首尾空白的 URL 候选。
 * @returns URL 具有 HTTP(S) 协议和主机名时返回 true。
 */
function isHttpUrl(value: string): boolean {
  try {
    /** 标准 URL 解析结果用于拒绝相对路径和不完整主机名。 */
    const parsed = new URL(value);
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.hostname.length > 0;
  } catch {
    return false;
  }
}

/**
 * 判断字符串是否为 Core 接受的 SPDX 许可表达式。
 *
 * @param value 已去除首尾空白的许可候选。
 * @returns SPDX Parser 接受该完整表达式时返回 true。
 */
function isSpdxExpression(value: string): boolean {
  try {
    parseSpdxExpression(value);
    return true;
  } catch {
    return false;
  }
}

/** 统一元数据字段及其旧 interface 回退来源。 */
interface MetadataCandidate {
  /** 报告中保留的精确旧字段路径。 */
  readonly field: string;
  /** 未经旧 Schema 校验的字段值。 */
  readonly value: unknown;
  /** 该字段是否只能作为统一字段的回退来源。 */
  readonly fallback: boolean;
}

/**
 * 从一组优先级候选选择首个合法文本，并逐项报告所有实际来源。
 *
 * @param fields 当前元数据资源的字段报告。
 * @param source 旧元数据清单相对路径。
 * @param candidates 主字段和 interface 回退字段的优先级列表。
 * @param label 不包含原始值的字段说明。
 * @param validate 对规范化文本执行的可选 Core 等价校验。
 * @returns 首个合法候选的规范化值。
 */
function selectMetadataText(
  fields: MigrationFieldDraft[],
  source: string,
  candidates: readonly MetadataCandidate[],
  label: string,
  validate: (value: string) => boolean = () => true,
): string | undefined {
  /** 每个实际来源的规范化结果；undefined 表示无法自动映射。 */
  const normalized = candidates.map(candidate => candidate.value === undefined
    ? undefined
    : normalizedText(candidate.value));
  /** 首个同时满足文本和字段专属契约的来源索引。 */
  const selectedIndex = normalized.findIndex(value => value !== undefined && validate(value));
  /** 最终进入规范配置的字段值。 */
  const selected = selectedIndex < 0 ? undefined : normalized[selectedIndex];
  for (const [index, candidate] of candidates.entries()) {
    if (candidate.value === undefined)
      continue;
    /** 当前来源去空白后的候选文本。 */
    const value = normalized[index];
    if (value === undefined || !validate(value)) {
      reportField(fields, candidate.field, source, 'unmapped', `${label} did not satisfy the canonical metadata contract.`);
    } else if (index === selectedIndex) {
      /** 回退选择或字符串规范化都必须在总体报告中保持 degraded。 */
      const normalizedOrFallback = candidate.fallback || value !== candidate.value;
      reportField(fields, candidate.field, source, normalizedOrFallback ? 'degraded' : 'mapped', normalizedOrFallback
        ? `${label} required fallback selection or whitespace normalization.`
        : `${label} maps directly to the corresponding top-level config field.`);
    } else if (value === selected) {
      reportField(fields, candidate.field, source, 'degraded', `${label} duplicates the selected source and was collapsed into one canonical field.`);
    } else {
      reportField(fields, candidate.field, source, 'unmapped', `${label} conflicts with the higher-priority source and cannot be represented separately.`);
    }
  }
  return selected;
}

/**
 * 从旧 Plugin 元数据、CLI 参数或交互提示中确定规范工程元数据。
 *
 * @param scan Legacy Scanner 结果。
 * @param options 迁移 CLI 选项。
 * @returns 已验证名称、版本、描述和可选展示名称。
 */
export async function metadataFor(scan: ScanResult, options: MigrationOptions, items: MigrationItem[]): Promise<PluginMetadata> {
  /** 仅 Plugin/Marketplace 扫描结果携带的旧 Plugin 元数据。 */
  const plugin = 'meta' in scan ? scan as PluginScanResult : undefined;
  /** Plugin 元数据来自清单；Project 的必填值来自 CLI 并以来源根表示。 */
  const source = plugin?.metadataSource ?? '.';
  /** 顶层元数据全部已发现字段的保真记录。 */
  const fields: MigrationFieldDraft[] = [];
  /** 只有普通对象形态的 Marketplace interface 才能安全枚举回退字段。 */
  const pluginInterface = isRecord(plugin?.meta.interface) ? plugin.meta.interface : undefined;
  if (plugin?.meta.interface !== undefined && pluginInterface === undefined)
    reportField(fields, 'interface', source, 'unmapped', 'Marketplace interface was not an object.');

  /** CLI 或旧元数据提供的原始名称候选。 */
  let rawName: unknown = options.name ?? plugin?.meta.name;
  if (rawName === undefined && process.stdin.isTTY)
    rawName = await input({ message: 'Plugin name', default: safeId(path.basename(scan.rootDir)) });
  if (rawName === undefined)
    throw new Error('Migration requires plugin name and description; pass --name and --description in non-interactive mode.');
  if (options.name !== undefined && !ID_PATTERN.test(options.name))
    throw new Error('Migration plugin name must be lowercase kebab-case.');
  /** 最终名称；旧名称可以安全规范化，显式 CLI 名称仍保持严格输入边界。 */
  const name = typeof rawName === 'string' && ID_PATTERN.test(rawName)
    ? rawName
    : safeId(typeof rawName === 'string' ? rawName : path.basename(scan.rootDir));
  reportField(fields, 'name', source,
    typeof rawName === 'string' && ID_PATTERN.test(rawName) && (options.name === undefined || plugin?.meta.name === undefined || plugin.meta.name === rawName)
      ? 'mapped'
      : typeof rawName === 'string' ? 'degraded' : 'unmapped',
    typeof rawName === 'string' && ID_PATTERN.test(rawName)
      ? options.name !== undefined && plugin?.meta.name !== undefined && plugin.meta.name !== rawName
        ? 'Explicit migration name overrides a different legacy identity.'
        : 'Plugin identity maps to top-level config name.'
      : typeof rawName === 'string'
        ? 'Legacy identity required lowercase kebab-case normalization.'
        : 'Invalid legacy identity required a directory-name fallback.');

  /** 旧根描述及两个 Marketplace interface 回退字段。 */
  const descriptionCandidates: readonly MetadataCandidate[] = [
    { field: 'description', value: plugin?.meta.description, fallback: false },
    { field: 'interface.shortDescription', value: pluginInterface?.shortDescription, fallback: true },
    { field: 'interface.longDescription', value: pluginInterface?.longDescription, fallback: true },
  ];
  /** 未提供 CLI 覆盖时由旧字段优先级选出的描述。 */
  const legacyDescription = options.description === undefined
    ? selectMetadataText(fields, source, descriptionCandidates, 'Description')
    : undefined;
  /** CLI 描述也按 Core 规则规范化，不允许空白字符串绕过。 */
  let description = normalizedText(options.description) ?? legacyDescription;
  if (options.description !== undefined) {
    if (description === undefined)
      throw new Error('Migration description must be a non-empty string.');
    /** candidate 表示被显式 CLI 描述取代、但仍必须报告的旧来源字段。 */
    for (const candidate of descriptionCandidates) {
      if (candidate.value === undefined)
        continue;
      /** 旧描述的规范化文本，用于区分无效输入与有意覆盖。 */
      const value = normalizedText(candidate.value);
      reportField(fields, candidate.field, source, value === undefined ? 'unmapped' : 'degraded', value === undefined
        ? 'Description did not satisfy the canonical metadata contract.'
        : 'Explicit migration description superseded this legacy description source.');
    }
    if (!plugin)
      reportField(fields, 'description', source, description === options.description ? 'mapped' : 'degraded', description === options.description
        ? 'Explicit description maps to top-level config description.'
        : 'Explicit description required whitespace normalization.');
  }
  if (description === undefined && process.stdin.isTTY)
    description = normalizedText(await input({ message: 'Plugin description' }));
  if (description === undefined)
    throw new Error('Migration requires plugin name and description; pass --name and --description in non-interactive mode.');

  /** npm SemVer 解析器与 Core 使用同一完整版本规则，包括 build metadata。 */
  const rawVersion = plugin?.meta.version as unknown;
  /** 合法旧版本或明确记录降级后的稳定迁移默认版本。 */
  const version = typeof rawVersion === 'string' && semver.valid(rawVersion) ? rawVersion : '0.1.0';
  if (rawVersion !== undefined) {
    reportField(fields, 'version', source, version === rawVersion ? 'mapped' : 'degraded', version === rawVersion
      ? 'Semantic version maps directly to top-level config version.'
      : 'Invalid legacy version required the 0.1.0 fallback.');
  } else {
    reportField(fields, 'version', source, 'degraded', 'Missing legacy version required the 0.1.0 migration default.');
  }

  /** 展示名称优先保留根字段，Marketplace interface 只提供显式降级回退。 */
  const displayName = selectMetadataText(fields, source, [
    { field: 'displayName', value: plugin?.meta.displayName, fallback: false },
    { field: 'interface.displayName', value: pluginInterface?.displayName, fallback: true },
  ], 'Display name');

  /** 旧 author 可能来自未经 Schema 校验的任意 JSON 值。 */
  const rawAuthor = plugin?.meta.author as unknown;
  /** 只有根 author.name 合法时才允许组合其 email/url。 */
  const authorRecord = isRecord(rawAuthor) ? rawAuthor : undefined;
  /** 根作者名称去空白后的候选。 */
  const rootAuthorName = normalizedText(authorRecord?.name);
  /** Marketplace 展示层开发者名称只作为作者回退。 */
  const developerName = normalizedText(pluginInterface?.developerName);
  /** 最终统一作者元数据。 */
  let author: PluginMetadata['author'];
  if (rawAuthor !== undefined && authorRecord === undefined)
    reportField(fields, 'author', source, 'unmapped', 'Author was not an object.');
  if (authorRecord !== undefined) {
    if (authorRecord.name === undefined || rootAuthorName === undefined) {
      reportField(fields, 'author.name', source, 'unmapped', 'Author name was not a non-empty string.');
    } else {
      reportField(fields, 'author.name', source, rootAuthorName === authorRecord.name ? 'mapped' : 'degraded', rootAuthorName === authorRecord.name
        ? 'Author name maps to top-level config author.name.'
        : 'Author name required whitespace normalization.');
    }
    /** 合法根身份下可以独立恢复的 email 与 URL。 */
    const authorDetails: { email?: string; url?: string } = {};
    for (const field of ['email', 'url'] as const) {
      /** 当前作者详情字段未经验证的原始值。 */
      const rawValue = authorRecord[field];
      if (rawValue === undefined)
        continue;
      /** 去空白后的 email 或 URL。 */
      const value = normalizedText(rawValue);
      /** 字段自身合法且具有可组合的作者身份时才写入。 */
      const valid = rootAuthorName !== undefined && value !== undefined
        && (field === 'email' ? EMAIL_PATTERN.test(value) : isHttpUrl(value));
      if (valid) {
        authorDetails[field] = value;
        reportField(fields, `author.${field}`, source, value === rawValue ? 'mapped' : 'degraded', value === rawValue
          ? `Author ${field} maps to top-level config author.${field}.`
          : `Author ${field} required whitespace normalization.`);
      } else {
        reportField(fields, `author.${field}`, source, 'unmapped', `Author ${field} did not satisfy the canonical metadata contract.`);
      }
    }
    /** key 表示旧 author 中当前无法识别的额外字段。 */
    for (const key of Object.keys(authorRecord).sort(compareCodeUnits)) {
      if (!['name', 'email', 'url'].includes(key))
        reportField(fields, `author.${key}`, source, 'unmapped', 'Unknown author field has no canonical mapping.');
    }
    if (rootAuthorName !== undefined)
      author = { name: rootAuthorName, ...authorDetails };
  }
  if (pluginInterface?.developerName !== undefined) {
    if (developerName === undefined) {
      reportField(fields, 'interface.developerName', source, 'unmapped', 'Developer name was not a non-empty string.');
    } else if (author === undefined) {
      author = { name: developerName };
      reportField(fields, 'interface.developerName', source, 'degraded', 'Developer name was used as the fallback canonical author.');
    } else if (author.name === developerName) {
      reportField(fields, 'interface.developerName', source, 'degraded', 'Developer name duplicates author.name and was collapsed.');
    } else {
      reportField(fields, 'interface.developerName', source, 'unmapped', 'Developer name conflicts with author.name and cannot be represented separately.');
    }
  }

  /** URL 字段均按绝对 HTTP(S) 规则验证，interface website 只能降级回退。 */
  const homepage = selectMetadataText(fields, source, [
    { field: 'homepage', value: plugin?.meta.homepage, fallback: false },
    { field: 'interface.websiteURL', value: pluginInterface?.websiteURL, fallback: true },
  ], 'Homepage', isHttpUrl);
  /** Repository 没有 interface 回退来源。 */
  const repository = selectMetadataText(fields, source, [
    { field: 'repository', value: plugin?.meta.repository, fallback: false },
  ], 'Repository', isHttpUrl);
  /** License 使用真实 SPDX Parser，不以非空字符串冒充合法表达式。 */
  const license = selectMetadataText(fields, source, [
    { field: 'license', value: plugin?.meta.license, fallback: false },
  ], 'License', isSpdxExpression);

  /** Keywords 允许去空白和去重，但任何这种规范化都必须 degraded。 */
  const rawKeywords = plugin?.meta.keywords as unknown;
  /** 只有结构有效时才写入配置的规范 keyword 列表。 */
  let keywords: readonly string[] | undefined;
  if (rawKeywords !== undefined) {
    if (!Array.isArray(rawKeywords) || rawKeywords.some(keyword => normalizedText(keyword) === undefined)) {
      reportField(fields, 'keywords', source, 'unmapped', 'Keywords must be an array of non-empty strings.');
    } else {
      /** 保持首次出现顺序的规范 keyword。 */
      const normalizedKeywords = rawKeywords.map(keyword => normalizedText(keyword)!);
      /** 去重后的规范 keyword 数组。 */
      const uniqueKeywords = [...new Set(normalizedKeywords)];
      /** 去空白或重复折叠都会改变旧字段表示。 */
      const changed = uniqueKeywords.length !== normalizedKeywords.length
        || normalizedKeywords.some((keyword, index) => keyword !== rawKeywords[index]);
      keywords = uniqueKeywords;
      reportField(fields, 'keywords', source, changed ? 'degraded' : 'mapped', changed
        ? 'Keywords required whitespace normalization or duplicate removal.'
        : 'Keywords map directly to the top-level config field.');
    }
  }

  if (plugin?.meta.category !== undefined)
    reportField(fields, 'category', source, 'unmapped', 'Platform-neutral metadata has no category field; configure it on a Platform factory.');
  if (plugin?.meta.apps !== undefined)
    reportField(fields, 'apps', source, 'unmapped', 'Legacy apps are outside the acplugin 1.0 component contract.');
  /** field 表示当前没有统一元数据或安全自动映射的旧 interface 字段。 */
  for (const field of Object.keys(pluginInterface ?? {}).sort(compareCodeUnits)) {
    if (!['displayName', 'shortDescription', 'longDescription', 'developerName', 'websiteURL'].includes(field))
      reportField(fields, `interface.${field}`, source, 'unmapped', 'The Marketplace interface field requires explicit Platform configuration.');
  }
  /** 只写入通过逐字段校验的元数据，避免最终 Pipeline 退化为无字段信息的通用失败。 */
  const metadata: PluginMetadata = {
    name,
    version,
    description,
    ...(displayName === undefined ? {} : { displayName }),
    ...(author === undefined ? {} : { author }),
    ...(homepage === undefined ? {} : { homepage }),
    ...(repository === undefined ? {} : { repository }),
    ...(license === undefined ? {} : { license }),
    keywords: keywords ?? [],
  };
  items.push(migrationItem({ kind: 'metadata', id: name, source, destination: 'acplugin.config.ts' }, fields));
  return metadata;
}
