import path from 'node:path';
import semver from 'semver';
import parseSpdxExpression from 'spdx-expression-parse';
import { DiagnosticCollector } from './diagnostics.js';
import { isAcpluginExtension, isAcpluginPlatform, type AcpluginPlatform } from './contracts.js';
import type {
  BuildCommand,
  BuildMode,
  PluginAuthor,
  PluginMetadata,
  ResolvedConfig,
  ResolvedPlatform,
  ResolvedPublicConfig,
  UserConfig,
} from './types.js';

/** Plugin 名称允许使用的小写 kebab-case 格式。 */
const NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Plugin 作者邮件地址使用的保守结构规则。 */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** 顶层最终配置唯一允许出现的字段。 */
const ALLOWED_FIELDS = new Set([
  'name', 'version', 'description', 'displayName', 'author', 'homepage',
  'repository', 'license', 'keywords', 'srcDir', 'public', 'platforms',
  'extensions', 'build',
]);

/** 需要定向提示最终写法、不能只报告 unknown 的旧配置字段。 */
const LEGACY_FIELDS = new Map([
  ['targets', 'Use platforms: [claudeCode(), codex()] instead.'],
  ['modules', 'Use extensions: [hooks(), mcp()] instead.'],
]);

/** Core 注入默认 Platform 时需要的外部工厂结果。 */
export interface ResolveConfigOptions {
  readonly defaultPlatforms: readonly AcpluginPlatform[];
}

/**
 * 判断未知值是否为可枚举的普通对象形态。
 *
 * @param value 需要检查的外部配置值。
 * @returns 非空、非数组对象返回 true。
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * 拒绝配置对象中未被当前 schema 明确允许的字段。
 *
 * @param value 待检查的配置对象。
 * @param allowed 当前层级允许的字段名称。
 * @param fieldPath 当前对象在完整配置中的字段路径。
 * @param diagnostics 用于收集结构错误的诊断容器。
 */
function rejectUnknownFields(
  value: Record<string, unknown>,
  allowed: readonly string[],
  fieldPath: readonly (string | number)[],
  diagnostics: DiagnosticCollector,
): void {
  /** Set 让字段检查保持确定性的同时避免每次查找都遍历数组。 */
  const accepted = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (accepted.has(key) || (fieldPath.length === 0 && LEGACY_FIELDS.has(key)))
      continue;
    diagnostics.error('CONFIG_FIELD_UNKNOWN', `Unknown configuration field "${[...fieldPath, key].join('.')}".`, {
      phase: 'config', fieldPath: [...fieldPath, key],
    });
  }
}

/**
 * 判断候选绝对路径是否位于指定根目录内。
 *
 * @param root 可信工程根目录。
 * @param candidate 需要验证的候选绝对路径。
 * @returns 候选路径等于或包含于根目录时返回 true。
 */
function isInside(root: string, candidate: string): boolean {
  /** lexical relative 结果；实际文件阶段还会验证符号链接和文件类型。 */
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

/**
 * 将用户路径解析为工程内绝对路径，并拒绝绝对输入与 root escape。
 *
 * @param root 可信工程根目录。
 * @param value 用户提供的相对路径。
 * @param field 产生该路径的配置字段。
 * @param diagnostics 用于记录路径错误的诊断容器。
 * @returns 规范化后的绝对路径；非法时仍返回结果以继续收集错误。
 */
function resolveInside(root: string, value: string, field: string, diagnostics: DiagnosticCollector): string {
  if (path.posix.isAbsolute(value) || path.win32.isAbsolute(value)) {
    diagnostics.error('CONFIG_PATH_ABSOLUTE', `${field} must be relative to the project root.`, {
      phase: 'config', fieldPath: field.split('.'),
    });
  }
  /** 保留解析结果可让一次 validate 汇总多个独立问题。 */
  const resolved = path.resolve(root, value);
  if (!isInside(root, resolved)) {
    diagnostics.error('CONFIG_PATH_ESCAPE', `${field} must stay inside the project root.`, {
      phase: 'config', fieldPath: field.split('.'),
    });
  }
  return resolved;
}

/**
 * 判断用户路径是否包含任一宿主都不应接受的绝对或逃逸语法。
 *
 * @param value 尚未按宿主或交付格式解释的用户路径。
 * @returns POSIX/Win32 绝对路径、NUL 或父目录片段存在时返回 true。
 */
function isUnsafePortablePath(value: string): boolean {
  return path.posix.isAbsolute(value)
    || path.win32.isAbsolute(value)
    || value.includes('\0')
    || value.split(/[\\/]/u).includes('..');
}

/**
 * 把 Public 交付目标统一为 POSIX 分隔符，不改变来源路径的宿主语义。
 *
 * @param value 已通过可移植安全检查的 Public 目标。
 * @returns 供 Scanner 展开和碰撞检查的 POSIX 目标文本。
 */
function normalizePublicTarget(value: string): string {
  return value.replaceAll('\\', '/');
}

/**
 * 判断两个目录是否相等或存在父子包含关系。
 *
 * @param left 左侧绝对目录。
 * @param right 右侧绝对目录。
 * @returns 任一目录包含另一目录时返回 true。
 */
function directoriesOverlap(left: string, right: string): boolean {
  return left === right || isInside(left, right) || isInside(right, left);
}

/**
 * 校验字符串是否为绝对 HTTP(S) URL。
 *
 * @param value 待校验的 URL 文本。
 * @returns 可由 URL 解析且协议为 http/https 时返回 true。
 */
function isHttpUrl(value: string): boolean {
  try {
    /** 使用标准 URL 解析器拒绝相对路径和不完整主机名。 */
    const parsed = new URL(value);
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.hostname.length > 0;
  } catch {
    return false;
  }
}

/**
 * 校验并规范化可选作者对象。
 *
 * @param value 配置中的 author 候选。
 * @param diagnostics 当前配置诊断集合。
 * @returns 字段完整时返回不可变作者元数据，否则返回 undefined。
 */
function resolveAuthor(value: unknown, diagnostics: DiagnosticCollector): PluginAuthor | undefined {
  if (value === undefined)
    return undefined;
  if (!isRecord(value)) {
    diagnostics.error('CONFIG_AUTHOR_INVALID', 'author must be an object.', { phase: 'config', fieldPath: ['author'] });
    return undefined;
  }
  rejectUnknownFields(value, ['name', 'email', 'url'], ['author'], diagnostics);
  if (typeof value.name !== 'string' || value.name.trim() === '')
    diagnostics.error('CONFIG_AUTHOR_NAME_INVALID', 'author.name must be a non-empty string.', { phase: 'config', fieldPath: ['author', 'name'] });
  if (value.email !== undefined && (typeof value.email !== 'string' || !EMAIL_PATTERN.test(value.email)))
    diagnostics.error('CONFIG_AUTHOR_EMAIL_INVALID', 'author.email must be a valid email address.', { phase: 'config', fieldPath: ['author', 'email'] });
  if (value.url !== undefined && (typeof value.url !== 'string' || !isHttpUrl(value.url)))
    diagnostics.error('CONFIG_AUTHOR_URL_INVALID', 'author.url must be an absolute HTTP(S) URL.', { phase: 'config', fieldPath: ['author', 'url'] });
  if (typeof value.name !== 'string' || value.name.trim() === '')
    return undefined;
  return {
    name: value.name.trim(),
    ...(typeof value.email === 'string' && EMAIL_PATTERN.test(value.email) ? { email: value.email } : {}),
    ...(typeof value.url === 'string' && isHttpUrl(value.url) ? { url: value.url } : {}),
  };
}

/**
 * 校验、去空白并去重 Plugin keywords。
 *
 * @param value 配置中的 keywords 候选。
 * @param diagnostics 当前配置诊断集合。
 * @returns 仅包含合法唯一值的稳定数组。
 */
function resolveKeywords(value: unknown, diagnostics: DiagnosticCollector): string[] | undefined {
  if (value === undefined)
    return undefined;
  if (!Array.isArray(value)) {
    diagnostics.error('CONFIG_KEYWORDS_INVALID', 'keywords must be an array of strings.', { phase: 'config', fieldPath: ['keywords'] });
    return undefined;
  }
  /** 保持用户顺序的规范 keyword 输出。 */
  const keywords: string[] = [];
  /** 用于拒绝去空白后重复 keyword 的集合。 */
  const seen = new Set<string>();
  for (const [index, keyword] of value.entries()) {
    if (typeof keyword !== 'string' || keyword.trim() === '') {
      diagnostics.error('CONFIG_KEYWORD_INVALID', 'Every keyword must be a non-empty string.', { phase: 'config', fieldPath: ['keywords', index] });
      continue;
    }
    /** 去除首尾空白后的最终 keyword。 */
    const normalized = keyword.trim();
    if (seen.has(normalized)) {
      diagnostics.error('CONFIG_KEYWORD_DUPLICATE', `Keyword "${normalized}" is duplicated.`, { phase: 'config', fieldPath: ['keywords', index] });
      continue;
    }
    seen.add(normalized);
    keywords.push(normalized);
  }
  return keywords;
}

/**
 * 解析 Public 目录开关、来源目录和复制规则。
 *
 * @param root 可信工程根目录。
 * @param value 用户提供的 Public 配置。
 * @param diagnostics 用于收集目录与复制规则错误的诊断容器。
 * @returns 包含绝对来源目录的统一 Public 配置。
 */
function resolvePublic(root: string, value: unknown, diagnostics: DiagnosticCollector): ResolvedPublicConfig {
  if (value === false)
    return { enabled: false, dir: path.join(root, 'public') };
  if (typeof value === 'string')
    return { enabled: true, dir: resolveInside(root, value, 'public', diagnostics) };
  if (value !== undefined && !isRecord(value)) {
    diagnostics.error('CONFIG_PUBLIC_INVALID', 'public must be false, a directory string, or an object.', { phase: 'config', fieldPath: ['public'] });
    return { enabled: true, dir: path.join(root, 'public') };
  }
  /** undefined 等价于启用默认 public 目录的空配置对象。 */
  const object = value ?? {};
  rejectUnknownFields(object, ['dir', 'copy'], ['public'], diagnostics);
  if (object.dir !== undefined && typeof object.dir !== 'string')
    diagnostics.error('CONFIG_PUBLIC_DIR_INVALID', 'public.dir must be a string.', { phase: 'config', fieldPath: ['public', 'dir'] });
  /** Public 来源目录必须位于工程根内。 */
  const dir = resolveInside(root, typeof object.dir === 'string' ? object.dir : 'public', 'public.dir', diagnostics);
  /** 仅保存字段类型完整的 copy rule。 */
  const copy: { from: string; to: string }[] = [];
  if (object.copy !== undefined && !Array.isArray(object.copy))
    diagnostics.error('CONFIG_PUBLIC_COPY_INVALID', 'public.copy must be an array.', { phase: 'config', fieldPath: ['public', 'copy'] });
  if (Array.isArray(object.copy)) {
    for (const [index, rawRule] of object.copy.entries()) {
      if (!isRecord(rawRule)) {
        diagnostics.error('CONFIG_PUBLIC_RULE_INVALID', 'Every Public copy rule must be an object.', { phase: 'config', fieldPath: ['public', 'copy', index] });
        continue;
      }
      rejectUnknownFields(rawRule, ['from', 'to'], ['public', 'copy', index], diagnostics);
      if (typeof rawRule.from !== 'string' || rawRule.from.trim() === '' || typeof rawRule.to !== 'string' || rawRule.to.trim() === '') {
        diagnostics.error('CONFIG_PUBLIC_RULE_INVALID', 'Public copy rules require non-empty string from and to fields.', { phase: 'config', fieldPath: ['public', 'copy', index] });
        continue;
      }
      /** 来源保持宿主文件系统语义，交付目标统一为 POSIX 分隔符。 */
      const rule = { from: rawRule.from, to: normalizePublicTarget(rawRule.to) };
      copy.push(rule);
      if (isUnsafePortablePath(rawRule.from) || isUnsafePortablePath(rawRule.to)) {
        diagnostics.error('CONFIG_PUBLIC_RULE_ESCAPE', 'Public copy paths must be relative and cannot contain parent traversal.', {
          phase: 'config', fieldPath: ['public', 'copy', index],
        });
      }
    }
  }
  return object.copy !== undefined ? { enabled: true, dir, copy } : { enabled: true, dir };
}

/**
 * 校验品牌化 Platform 实例并应用全局 strict 默认值。
 *
 * @param value 显式 platforms 值或 undefined。
 * @param defaults 主包注入的默认 Platform 工厂结果。
 * @param strict 全局功能兼容性严格度。
 * @param diagnostics 当前配置诊断集合。
 * @returns 保持配置顺序的最终 Platform 列表。
 */
function resolvePlatforms(
  value: unknown,
  defaults: readonly AcpluginPlatform[],
  strict: boolean,
  diagnostics: DiagnosticCollector,
): ResolvedPlatform[] {
  if (value !== undefined && !Array.isArray(value)) {
    diagnostics.error('CONFIG_PLATFORMS_INVALID', 'platforms must be an array of Platform factory results.', { phase: 'config', fieldPath: ['platforms'] });
    return [];
  }
  /** 省略字段时使用默认工厂，显式数组则完整替换默认集合。 */
  const input = value === undefined ? defaults : value;
  if (input.length === 0)
    diagnostics.error('CONFIG_PLATFORMS_EMPTY', 'platforms must contain at least one Platform.', { phase: 'config', fieldPath: ['platforms'] });
  /** 用于拒绝重复 Platform ID 的集合。 */
  const seen = new Set<string>();
  /** 已通过品牌和版本检查的 Platform。 */
  const resolved: ResolvedPlatform[] = [];
  for (const [index, candidate] of input.entries()) {
    if (!isAcpluginPlatform(candidate)) {
      /** 字段看似 Platform 但版本不同，优先给出版本定向错误。 */
      const apiVersion = isRecord(candidate) ? candidate.apiVersion : undefined;
      diagnostics.error(apiVersion !== undefined && apiVersion !== '1' ? 'CONFIG_PLATFORM_API_INCOMPATIBLE' : 'CONFIG_PLATFORM_INVALID',
        apiVersion !== undefined && apiVersion !== '1'
          ? `Platform API version "${String(apiVersion)}" is incompatible with Core API version 1.`
          : 'Every platform must be created by definePlatform() or an official Platform factory.',
        { phase: 'config', fieldPath: ['platforms', index] });
      continue;
    }
    if (seen.has(candidate.id)) {
      diagnostics.error('CONFIG_PLATFORM_DUPLICATE', `Platform "${candidate.id}" is configured more than once.`, { phase: 'config', fieldPath: ['platforms', index] });
      continue;
    }
    seen.add(candidate.id);
    resolved.push({ platform: candidate, strict: candidate.strict ?? strict });
  }
  return resolved;
}

/**
 * 校验品牌化 Extension 实例、API 版本和唯一名称。
 *
 * @param value 配置中的 extensions 候选。
 * @param diagnostics 当前配置诊断集合。
 * @returns 保持配置顺序的最终 Extension 列表。
 */
function resolveExtensions(value: unknown, diagnostics: DiagnosticCollector): import('./contracts.js').AcpluginExtension[] {
  if (value === undefined)
    return [];
  if (!Array.isArray(value)) {
    diagnostics.error('CONFIG_EXTENSIONS_INVALID', 'extensions must be an array of Extension factory results.', { phase: 'config', fieldPath: ['extensions'] });
    return [];
  }
  /** 用于拒绝重复 Extension 名称的集合。 */
  const seen = new Set<string>();
  /** 已通过品牌、版本和名称校验的 Extension。 */
  const resolved: import('./contracts.js').AcpluginExtension[] = [];
  for (const [index, candidate] of value.entries()) {
    if (!isAcpluginExtension(candidate)) {
      /** 字段看似 Extension 但版本不同，优先给出版本定向错误。 */
      const apiVersion = isRecord(candidate) ? candidate.apiVersion : undefined;
      diagnostics.error(apiVersion !== undefined && apiVersion !== '1' ? 'CONFIG_EXTENSION_API_INCOMPATIBLE' : 'CONFIG_EXTENSION_INVALID',
        apiVersion !== undefined && apiVersion !== '1'
          ? `Extension API version "${String(apiVersion)}" is incompatible with Core API version 1.`
          : 'Every extension must be created by defineExtension() or an official Extension factory.',
        { phase: 'config', fieldPath: ['extensions', index] });
      continue;
    }
    if (seen.has(candidate.name)) {
      diagnostics.error('CONFIG_EXTENSION_DUPLICATE', `Extension "${candidate.name}" is configured more than once.`, { phase: 'config', fieldPath: ['extensions', index] });
      continue;
    }
    seen.add(candidate.name);
    resolved.push(candidate);
  }
  return resolved;
}

/**
 * 将用户配置严格校验并解析为 Core 可直接消费的最终配置。
 *
 * @param value 从可信 acplugin.config.ts 加载的用户配置对象。
 * @param configPath 配置文件绝对路径或可解析路径。
 * @param command 当前执行的 CLI 构建命令。
 * @param mode 当前构建运行模式。
 * @param options 主包提供的默认 Platform 工厂结果。
 * @returns 成功时包含完整配置；失败时只返回已脱敏、可排序的诊断。
 */
export function resolveConfig(
  value: UserConfig,
  configPath: string,
  command: BuildCommand,
  mode: BuildMode,
  options: ResolveConfigOptions,
): { config?: ResolvedConfig; diagnostics: readonly import('./types.js').Diagnostic[] } {
  /** 单次解析共享同一个 Collector，以汇总全部独立问题。 */
  const diagnostics = new DiagnosticCollector();
  /** 配置文件所在目录定义所有工程相对路径的信任根。 */
  const root = path.dirname(path.resolve(configPath));
  /** 降级为 unknown，确保运行时校验不依赖静态类型。 */
  const object = value as unknown;
  if (!isRecord(object)) {
    diagnostics.error('CONFIG_OBJECT_REQUIRED', 'Configuration must be an object.', { phase: 'config' });
    return { diagnostics: diagnostics.diagnostics };
  }

  rejectUnknownFields(object, [...ALLOWED_FIELDS], [], diagnostics);
  for (const [field, hint] of LEGACY_FIELDS) {
    if (field in object) {
      diagnostics.error(`CONFIG_LEGACY_${field.toUpperCase()}`, `Legacy configuration field "${field}" is not supported.`, {
        phase: 'config', fieldPath: [field], hint,
      });
    }
  }

  if (typeof object.name !== 'string' || !NAME_PATTERN.test(object.name))
    diagnostics.error('CONFIG_NAME_INVALID', 'name must be lowercase kebab-case.', { phase: 'config', fieldPath: ['name'] });
  if (typeof object.version !== 'string' || !semver.valid(object.version))
    diagnostics.error('CONFIG_VERSION_INVALID', 'version must be complete valid SemVer.', { phase: 'config', fieldPath: ['version'] });
  if (typeof object.description !== 'string' || object.description.trim() === '')
    diagnostics.error('CONFIG_DESCRIPTION_REQUIRED', 'description is required.', { phase: 'config', fieldPath: ['description'] });
  if (object.displayName !== undefined && (typeof object.displayName !== 'string' || object.displayName.trim() === ''))
    diagnostics.error('CONFIG_DISPLAY_NAME_INVALID', 'displayName must be a non-empty string.', { phase: 'config', fieldPath: ['displayName'] });
  if (object.srcDir !== undefined && (typeof object.srcDir !== 'string' || object.srcDir.trim() === ''))
    diagnostics.error('CONFIG_SRC_DIR_INVALID', 'srcDir must be a non-empty string.', { phase: 'config', fieldPath: ['srcDir'] });
  for (const field of ['homepage', 'repository'] as const) {
    if (object[field] !== undefined && (typeof object[field] !== 'string' || !isHttpUrl(object[field])))
      diagnostics.error(`CONFIG_${field.toUpperCase()}_INVALID`, `${field} must be an absolute HTTP(S) URL.`, { phase: 'config', fieldPath: [field] });
  }
  if (object.license !== undefined) {
    if (typeof object.license !== 'string' || object.license.trim() === '') {
      diagnostics.error('CONFIG_LICENSE_INVALID', 'license must be a valid SPDX expression.', { phase: 'config', fieldPath: ['license'] });
    } else {
      try {
        parseSpdxExpression(object.license);
      } catch {
        diagnostics.error('CONFIG_LICENSE_INVALID', 'license must be a valid SPDX expression.', { phase: 'config', fieldPath: ['license'] });
      }
    }
  }

  /** 已校验或部分规范化的可选作者。 */
  const author = resolveAuthor(object.author, diagnostics);
  /** 已去空白并检查重复项的可选关键词。 */
  const keywords = resolveKeywords(object.keywords, diagnostics);
  /** 非法 build 值不会进入后续字段读取。 */
  let build: Record<string, unknown> = {};
  if (object.build !== undefined) {
    if (!isRecord(object.build))
      diagnostics.error('CONFIG_BUILD_INVALID', 'build must be an object.', { phase: 'config', fieldPath: ['build'] });
    else
      build = object.build;
  }
  rejectUnknownFields(build, ['outDir', 'strict'], ['build'], diagnostics);
  if (build.outDir !== undefined && (typeof build.outDir !== 'string' || build.outDir.trim() === ''))
    diagnostics.error('CONFIG_OUT_DIR_INVALID', 'build.outDir must be a non-empty string.', { phase: 'config', fieldPath: ['build', 'outDir'] });
  if (build.strict !== undefined && typeof build.strict !== 'boolean')
    diagnostics.error('CONFIG_STRICT_INVALID', 'build.strict must be boolean.', { phase: 'config', fieldPath: ['build', 'strict'] });

  /** 严格模式默认开启，Platform 工厂可以单独覆盖。 */
  const strict = typeof build.strict === 'boolean' ? build.strict : true;
  /** Scanner 使用的工程内绝对源码目录。 */
  const srcDir = resolveInside(root, typeof object.srcDir === 'string' ? object.srcDir : 'src', 'srcDir', diagnostics);
  /** 事务层使用的工程内绝对输出目录。 */
  const outDir = resolveInside(root, typeof build.outDir === 'string' ? build.outDir : 'dist', 'build.outDir', diagnostics);
  /** 已解析的 Public 来源与 copy rule。 */
  const publicConfig = resolvePublic(root, object.public, diagnostics);
  /** 已品牌校验且带最终 strictness 的 Platform。 */
  const platforms = resolvePlatforms(object.platforms, options.defaultPlatforms, strict, diagnostics);
  /** 已品牌校验且名称唯一的 Extension。 */
  const extensions = resolveExtensions(object.extensions, diagnostics);

  if (outDir === root)
    diagnostics.error('CONFIG_OUTDIR_ROOT', 'build.outDir cannot be the project root.', { phase: 'config', fieldPath: ['build', 'outDir'] });
  if (directoriesOverlap(srcDir, outDir))
    diagnostics.error('CONFIG_DIRECTORY_OVERLAP', 'srcDir and build.outDir cannot contain each other.', { phase: 'config' });
  if (publicConfig.enabled && directoriesOverlap(publicConfig.dir, outDir))
    diagnostics.error('CONFIG_DIRECTORY_OVERLAP', 'Public directory and build.outDir cannot contain each other.', { phase: 'config' });
  if (publicConfig.enabled && directoriesOverlap(publicConfig.dir, srcDir))
    diagnostics.error('CONFIG_DIRECTORY_OVERLAP', 'Public directory and srcDir cannot contain each other.', { phase: 'config' });

  if (diagnostics.hasErrors)
    return { diagnostics: diagnostics.diagnostics };

  /** 成功解析后供 Scanner 和 Platform 共享的统一元数据。 */
  const metadata: PluginMetadata = {
    name: object.name as string,
    version: object.version as string,
    description: (object.description as string).trim(),
    ...(typeof object.displayName === 'string' ? { displayName: object.displayName.trim() } : {}),
    ...(author === undefined ? {} : { author }),
    ...(typeof object.homepage === 'string' ? { homepage: object.homepage } : {}),
    ...(typeof object.repository === 'string' ? { repository: object.repository } : {}),
    ...(typeof object.license === 'string' ? { license: object.license } : {}),
    ...(keywords === undefined ? {} : { keywords }),
  };
  /** 只有不存在错误诊断时才构造类型完备的 ResolvedConfig。 */
  const config: ResolvedConfig = {
    root,
    configPath: path.resolve(configPath),
    command,
    mode,
    metadata,
    srcDir,
    public: publicConfig,
    platforms,
    extensions,
    outDir,
    strict,
  };
  return { config, diagnostics: diagnostics.diagnostics };
}
