import path from 'node:path';
import semver from 'semver';
import parseSpdxExpression from 'spdx-expression-parse';
import type {
  AcpluginExtension,
  AcpluginPlatform,
} from '../contracts/integrations.js';
import type {
  BuildMode,
  ConfigCommand,
  PluginAuthor,
  PluginMetadata,
  PublicCopyRule,
} from '../contracts/config.js';
import type { PortableNodeCompileOptions } from '../contracts/compiler.js';
import { isAcpluginExtension, isAcpluginPlatform } from '../api/definitions.js';
import { normalizePortableOptions } from '../compiler/portable-node/options.js';
import { DiagnosticRegistry } from '../services/diagnostics.js';
import { isInsidePath, safeRelativePath } from '../security/path-policy.js';

/** Kernel 使用的绝对路径 Public copy rule。 */
export interface ResolvedPublicCopyRule extends PublicCopyRule {
  readonly source: string;
}

/** Kernel 使用的完整 Public 配置。 */
export interface ResolvedPublicConfig {
  readonly enabled: boolean;
  readonly directory: string;
  readonly copy?: readonly ResolvedPublicCopyRule[];
}

/** Kernel 使用的内建 Runtime 配置。 */
export interface ResolvedRuntimeConfig {
  readonly enabled: boolean;
  readonly directory: string;
  readonly target: 'node20';
  readonly entries?: Readonly<Record<string, Readonly<{ entry: string; kind: 'executable' | 'module' }>>>;
  readonly compile?: PortableNodeCompileOptions;
}

/** 带最终 strictness 的选中 Platform。 */
export interface ResolvedPlatform {
  readonly definition: AcpluginPlatform;
  readonly strict: boolean;
}

/** 不向 SDK 暴露物理路径的 Kernel 私有最终配置。 */
export interface ResolvedKernelConfig {
  readonly projectRoot: string;
  readonly configFile: string;
  readonly command: ConfigCommand;
  readonly mode: BuildMode;
  readonly metadata: Readonly<PluginMetadata>;
  readonly srcDirectory: string;
  readonly public: ResolvedPublicConfig;
  readonly runtime: ResolvedRuntimeConfig;
  readonly platforms: readonly ResolvedPlatform[];
  readonly extensions: readonly AcpluginExtension[];
  readonly outDirectory: string;
  readonly strict: boolean;
}

/** 配置各层使用的 plain data property 描述符。 */
type Descriptors = Record<string, PropertyDescriptor>;

/** 顶层配置唯一字段集合。 */
const USER_CONFIG_FIELDS = new Set([
  'name', 'version', 'description', 'displayName', 'author', 'homepage', 'repository',
  'license', 'keywords', 'srcDir', 'public', 'runtime', 'platforms', 'extensions', 'build',
]);

/** 作者邮件地址的保守结构约束。 */
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;

/** Plugin name 和 Runtime ID 共用 lowercase-kebab 规则。 */
const STABLE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

/**
 * 读取不带 accessor/Symbol/原型行为的对象字段。
 *
 * @param value 未受信任的配置值。
 * @param label 稳定诊断标签。
 * @param diagnostics 当前配置诊断集合。
 * @param fieldPath 配置字段路径。
 * @returns 合法对象的 data descriptors。
 */
function descriptors(
  value: unknown,
  label: string,
  diagnostics: DiagnosticRegistry,
  fieldPath: readonly (string | number)[],
): Descriptors | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    diagnostics.report('config', {
      code: 'CONFIG_OBJECT_INVALID', severity: 'error', message: `${label} must be a plain object.`, fieldPath,
    });
    return undefined;
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    diagnostics.report('config', {
      code: 'CONFIG_SYMBOL_INVALID', severity: 'error', message: `${label} must not contain Symbol fields.`, fieldPath,
    });
    return undefined;
  }
  /** descriptor 读取不会执行 getter。 */
  const result = Object.getOwnPropertyDescriptors(value);
  for (const [field, descriptor] of Object.entries(result)) {
    if (!('value' in descriptor)) {
      diagnostics.report('config', {
        code: 'CONFIG_ACCESSOR_INVALID', severity: 'error', message: `${label}.${field} must be a data property.`, fieldPath: [...fieldPath, field],
      });
      return undefined;
    }
  }
  return result;
}

/**
 * 报告未知对象字段。
 *
 * @param values 当前对象 descriptors。
 * @param allowed 白名单。
 * @param diagnostics 当前诊断集合。
 * @param fieldPath 当前字段路径。
 */
function unknownFields(values: Descriptors, allowed: ReadonlySet<string>, diagnostics: DiagnosticRegistry, fieldPath: readonly (string | number)[]): void {
  for (const field of Object.keys(values).sort()) {
    if (!allowed.has(field)) {
      diagnostics.report('config', {
        code: 'CONFIG_FIELD_UNKNOWN', severity: 'error', message: `Unknown configuration field "${[...fieldPath, field].join('.')}".`, fieldPath: [...fieldPath, field],
      });
    }
  }
}

/**
 * 解析 project-relative POSIX 路径。
 *
 * @param root 可信工程根。
 * @param value 配置路径值。
 * @param fallback 缺省相对路径。
 * @param label 诊断标签。
 * @param diagnostics 当前诊断集合。
 * @param allowDot 是否允许 `.` 表示工程根。
 * @returns 仍位于工程内的绝对路径。
 */
function projectPath(
  root: string,
  value: unknown,
  fallback: string,
  label: string,
  diagnostics: DiagnosticRegistry,
  allowDot = false,
): string {
  /** 无效输入仍返回安全 fallback，以便一次汇总更多独立配置问题。 */
  let relative = fallback;
  if (value !== undefined) {
    if (typeof value !== 'string' || (value === '.' ? !allowDot : value.length === 0)) {
      diagnostics.report('config', { code: 'CONFIG_PATH_INVALID', severity: 'error', message: `${label} must be a project-relative POSIX path.`, fieldPath: label.split('.') });
    } else {
      try {
        relative = value === '.' && allowDot ? '' : safeRelativePath(value);
      } catch {
        diagnostics.report('config', { code: 'CONFIG_PATH_INVALID', severity: 'error', message: `${label} must be a project-relative POSIX path.`, fieldPath: label.split('.') });
      }
    }
  }
  /** 安全 POSIX segments 按宿主路径拼接。 */
  const resolved = relative === '' ? root : path.join(root, ...relative.split('/'));
  if (!isInsidePath(root, resolved))
    throw new Error('Resolved configuration path escaped the project root.');
  return resolved;
}

/**
 * 判断两个物理目录/文件边界是否互相包含。
 *
 * @param left 左侧绝对路径。
 * @param right 右侧绝对路径。
 * @returns 任一方向包含时为 true。
 */
function overlaps(left: string, right: string): boolean {
  return isInsidePath(left, right) || isInsidePath(right, left);
}

/**
 * 解析并冻结作者信息。
 *
 * @param value author 配置值。
 * @param diagnostics 当前诊断集合。
 * @returns 合法作者或 undefined。
 */
function author(value: unknown, diagnostics: DiagnosticRegistry): PluginAuthor | undefined {
  if (value === undefined)
    return undefined;
  /** author 必须先转为不会触发 getter 的字段描述符。 */
  const values = descriptors(value, 'author', diagnostics, ['author']);
  if (values === undefined)
    return undefined;
  unknownFields(values, new Set(['name', 'email', 'url']), diagnostics, ['author']);
  /** 当前 author 字段 data values。 */
  const name = values.name?.value;
  /** email 保留原始输入供独立格式校验。 */
  const email = values.email?.value;
  /** url 只允许可公开报告的 HTTP(S) 地址。 */
  const url = values.url?.value;
  if (typeof name !== 'string' || name.trim() === '')
    diagnostics.report('config', { code: 'CONFIG_AUTHOR_NAME_INVALID', severity: 'error', message: 'author.name must be a non-empty string.', fieldPath: ['author', 'name'] });
  if (email !== undefined && (typeof email !== 'string' || !EMAIL.test(email)))
    diagnostics.report('config', { code: 'CONFIG_AUTHOR_EMAIL_INVALID', severity: 'error', message: 'author.email must be a valid email address.', fieldPath: ['author', 'email'] });
  if (url !== undefined && (typeof url !== 'string' || !isHttpUrl(url)))
    diagnostics.report('config', { code: 'CONFIG_AUTHOR_URL_INVALID', severity: 'error', message: 'author.url must be an absolute HTTP URL.', fieldPath: ['author', 'url'] });
  if (typeof name !== 'string' || name.trim() === '')
    return undefined;
  return Object.freeze({
    name: name.trim(),
    ...(typeof email === 'string' && EMAIL.test(email) ? { email } : {}),
    ...(typeof url === 'string' && isHttpUrl(url) ? { url } : {}),
  });
}

/** @returns 只接受 HTTP/HTTPS 的 URL 是否有效。 */
function isHttpUrl(value: string): boolean {
  try {
    return new Set(['http:', 'https:']).has(new URL(value).protocol);
  } catch {
    return false;
  }
}

/**
 * 复制 keyword 数组。
 *
 * @param value 配置值。
 * @param diagnostics 当前诊断集合。
 * @returns 稳定、唯一 keyword 集。
 */
function keywords(value: unknown, diagnostics: DiagnosticRegistry): readonly string[] {
  if (value === undefined)
    return Object.freeze([]);
  if (!Array.isArray(value)) {
    diagnostics.report('config', { code: 'CONFIG_KEYWORDS_INVALID', severity: 'error', message: 'keywords must be an array.', fieldPath: ['keywords'] });
    return Object.freeze([]);
  }
  /** 调用方数组在任何异步边界前复制。 */
  const input = [...value];
  /** 规范化后的唯一 keyword。 */
  const result: string[] = [];
  for (const [index, item] of input.entries()) {
    if (typeof item !== 'string' || item.trim() === '') {
      diagnostics.report('config', { code: 'CONFIG_KEYWORD_INVALID', severity: 'error', message: 'Every keyword must be a non-empty string.', fieldPath: ['keywords', index] });
      continue;
    }
    /** keyword 比较使用去除两端空白后的规范文本。 */
    const normalized = item.trim();
    if (result.includes(normalized)) {
      diagnostics.report('config', { code: 'CONFIG_KEYWORD_DUPLICATE', severity: 'error', message: `Keyword "${normalized}" is duplicated.`, fieldPath: ['keywords', index] });
      continue;
    }
    result.push(normalized);
  }
  return Object.freeze(result);
}

/**
 * 解析 Public 精确映射。
 *
 * @param root 工程根。
 * @param value public 配置。
 * @param protectedPaths 不得被 Public 来源覆盖的路径。
 * @param diagnostics 当前诊断集合。
 * @returns 统一 Public 配置。
 */
function publicConfig(
  root: string,
  value: unknown,
  protectedPaths: readonly string[],
  diagnostics: DiagnosticRegistry,
): ResolvedPublicConfig {
  if (value === false)
    return Object.freeze({ enabled: false, directory: path.join(root, 'public') });
  if (typeof value === 'string') {
    /** 字符串简写表示完整复制一个工程内目录。 */
    const directory = projectPath(root, value, 'public', 'public', diagnostics, true);
    if (protectedPaths.some(protectedPath => overlaps(directory, protectedPath)))
      diagnostics.report('config', { code: 'CONFIG_PUBLIC_OVERLAP', severity: 'error', message: 'Public full-tree source overlaps a protected project path.', fieldPath: ['public'] });
    return Object.freeze({ enabled: true, directory });
  }
  /** 对象写法允许完整目录或精确 copy rules。 */
  const values = value === undefined ? {} : descriptors(value, 'public', diagnostics, ['public']);
  if (values === undefined)
    return Object.freeze({ enabled: true, directory: path.join(root, 'public') });
  unknownFields(values, new Set(['dir', 'copy']), diagnostics, ['public']);
  /** 每条 copy rule 都以最终 Public directory 为解析边界。 */
  const directory = projectPath(root, values.dir?.value, 'public', 'public.dir', diagnostics, true);
  if (values.copy === undefined) {
    if (protectedPaths.some(protectedPath => overlaps(directory, protectedPath)))
      diagnostics.report('config', { code: 'CONFIG_PUBLIC_OVERLAP', severity: 'error', message: 'Public full-tree source overlaps a protected project path.', fieldPath: ['public'] });
    return Object.freeze({ enabled: true, directory });
  }
  if (!Array.isArray(values.copy.value)) {
    diagnostics.report('config', { code: 'CONFIG_PUBLIC_COPY_INVALID', severity: 'error', message: 'public.copy must be an array.', fieldPath: ['public', 'copy'] });
    return Object.freeze({ enabled: true, directory, copy: Object.freeze([]) });
  }
  /** 每条规则按精确 resolved source 独立验证 overlap。 */
  const rules: ResolvedPublicCopyRule[] = [];
  for (const [index, raw] of [...values.copy.value].entries()) {
    /** 单条规则继续使用 descriptor 边界避免 accessor 执行。 */
    const rule = descriptors(raw, 'Public copy rule', diagnostics, ['public', 'copy', index]);
    if (rule === undefined)
      continue;
    unknownFields(rule, new Set(['from', 'to']), diagnostics, ['public', 'copy', index]);
    try {
      /** 来源路径必须是未折叠的安全 POSIX 相对路径。 */
      const from = safeRelativePath(rule.from?.value);
      /** 目标路径使用相同语法边界以保持跨平台一致。 */
      const to = safeRelativePath(rule.to?.value);
      /** resolved source 只留在 Kernel 私有配置中。 */
      const source = path.join(directory, ...from.split('/'));
      if (!isInsidePath(directory, source))
        throw new TypeError('escape');
      if (protectedPaths.some(protectedPath => overlaps(source, protectedPath))) {
        diagnostics.report('config', { code: 'CONFIG_PUBLIC_OVERLAP', severity: 'error', message: 'Public copy source overlaps a protected project path.', fieldPath: ['public', 'copy', index, 'from'] });
      }
      rules.push(Object.freeze({ from, to, source }));
    } catch {
      diagnostics.report('config', { code: 'CONFIG_PUBLIC_RULE_INVALID', severity: 'error', message: 'Public copy paths must be non-empty project-relative POSIX paths.', fieldPath: ['public', 'copy', index] });
    }
  }
  return Object.freeze({ enabled: true, directory, copy: Object.freeze(rules) });
}

/**
 * 解析 Runtime 声明和 portable 参数。
 *
 * @param srcDirectory 最终 srcDir。
 * @param value runtime 配置。
 * @param diagnostics 当前诊断集合。
 * @returns 固定 Runtime 配置。
 */
function runtimeConfig(srcDirectory: string, value: unknown, diagnostics: DiagnosticRegistry): ResolvedRuntimeConfig {
  /** Runtime 作者格式固定占用 srcDir/runtime。 */
  const directory = path.join(srcDirectory, 'runtime');
  if (value === false)
    return Object.freeze({ enabled: false, directory, target: 'node20' });
  /** 省略配置等价于启用约定式自动入口。 */
  const values = value === undefined ? {} : descriptors(value, 'runtime', diagnostics, ['runtime']);
  if (values === undefined)
    return Object.freeze({ enabled: true, directory, target: 'node20' });
  unknownFields(values, new Set(['target', 'entries', 'compile']), diagnostics, ['runtime']);
  if (values.target !== undefined && values.target.value !== 'node20')
    diagnostics.report('config', { code: 'RUNTIME_TARGET_INVALID', severity: 'error', message: 'runtime.target must be node20.', fieldPath: ['runtime', 'target'] });
  /** entries 字段存在时完整替换自动发现，包括显式空对象。 */
  let entries: Record<string, Readonly<{ entry: string; kind: 'executable' | 'module' }>> | undefined;
  if (values.entries !== undefined) {
    entries = {};
    /** 显式 entries 对象完整替换自动发现集合。 */
    const inputs = descriptors(values.entries.value, 'runtime.entries', diagnostics, ['runtime', 'entries']);
    for (const id of Object.keys(inputs ?? {}).sort()) {
      if (!STABLE_ID.test(id))
        diagnostics.report('config', { code: 'RUNTIME_ENTRY_ID_INVALID', severity: 'error', message: `Runtime entry ID "${id}" must use lowercase kebab-case.`, fieldPath: ['runtime', 'entries', id] });
      /** 单个入口必须是只含 entry/kind 的 plain data。 */
      const entry = descriptors(inputs![id]!.value, `runtime.entries.${id}`, diagnostics, ['runtime', 'entries', id]);
      if (entry === undefined)
        continue;
      unknownFields(entry, new Set(['entry', 'kind']), diagnostics, ['runtime', 'entries', id]);
      try {
        /** 入口只能引用 Runtime root 内的相对源码。 */
        const source = safeRelativePath(entry.entry?.value);
        /** 省略 kind 时使用可直接执行的默认交付语义。 */
        const kind = entry.kind?.value ?? 'executable';
        if (kind !== 'executable' && kind !== 'module')
          throw new TypeError('kind');
        entries[id] = Object.freeze({ entry: source, kind });
      } catch {
        diagnostics.report('config', { code: 'RUNTIME_ENTRY_INVALID', severity: 'error', message: `Runtime entry "${id}" must declare a relative source and executable or module kind.`, fieldPath: ['runtime', 'entries', id] });
      }
    }
  }
  /** portable 参数只使用 Compiler Host 的唯一 runtime normalizer。 */
  let compile: PortableNodeCompileOptions | undefined;
  if (values.compile !== undefined) {
    try {
      compile = normalizePortableOptions(values.compile.value);
    } catch {
      diagnostics.report('config', { code: 'RUNTIME_COMPILE_INVALID', severity: 'error', message: 'runtime.compile contains unsupported portable-node options.', fieldPath: ['runtime', 'compile'] });
    }
  }
  return Object.freeze({
    enabled: true,
    directory,
    target: 'node20',
    ...(entries === undefined ? {} : { entries: Object.freeze(entries) }),
    ...(compile === undefined ? {} : { compile }),
  });
}

/**
 * 将作者配置解析为 Kernel 私有不可变配置。
 *
 * @param value Module Host 返回的未知 default export。
 * @param options 固定工程身份和执行环境。
 * @returns 配置成功时的 snapshot 及全部稳定诊断。
 */
export function resolveKernelConfig(
  value: unknown,
  options: {
    readonly projectRoot: string;
    readonly configFile: string;
    readonly command: ConfigCommand;
    readonly mode: BuildMode;
  },
): { readonly config?: ResolvedKernelConfig; readonly diagnostics: readonly import('../contracts/reports.js').Diagnostic[] } {
  /** 所有配置错误集中到同一稳定 Registry 后一次返回。 */
  const diagnostics = new DiagnosticRegistry();
  /** 工程根由 Project 层固定，不能退化为 config 所在目录。 */
  const projectRoot = path.resolve(options.projectRoot);
  /** 配置文件必须已由 Project/Source policy 确认为工程内文件。 */
  const configFile = path.resolve(options.configFile);
  if (!isInsidePath(projectRoot, configFile))
    diagnostics.report('config', { code: 'CONFIG_FILE_OUTSIDE_PROJECT', severity: 'error', message: 'Configuration file must be inside the project root.' });
  /** 顶层输入也必须先证明为无行为 plain data。 */
  const values = descriptors(value, 'Configuration', diagnostics, []);
  if (values === undefined)
    return { diagnostics: diagnostics.diagnostics };
  unknownFields(values, USER_CONFIG_FIELDS, diagnostics, []);

  /** 三个必填 metadata 字段。 */
  const name = values.name?.value;
  /** version 保留原始值交给完整 SemVer 校验。 */
  const version = values.version?.value;
  /** description 最终会去除两端空白并冻结。 */
  const description = values.description?.value;
  if (typeof name !== 'string' || !STABLE_ID.test(name))
    diagnostics.report('config', { code: 'CONFIG_NAME_INVALID', severity: 'error', message: 'name must use lowercase kebab-case.', fieldPath: ['name'] });
  if (typeof version !== 'string' || semver.valid(version) === null)
    diagnostics.report('config', { code: 'CONFIG_VERSION_INVALID', severity: 'error', message: 'version must be a complete SemVer.', fieldPath: ['version'] });
  if (typeof description !== 'string' || description.trim() === '')
    diagnostics.report('config', { code: 'CONFIG_DESCRIPTION_REQUIRED', severity: 'error', message: 'description must be a non-empty string.', fieldPath: ['description'] });
  /** displayName 是可选的人类可读展示名。 */
  const displayName = values.displayName?.value;
  if (displayName !== undefined && (typeof displayName !== 'string' || displayName.trim() === ''))
    diagnostics.report('config', { code: 'CONFIG_DISPLAY_NAME_INVALID', severity: 'error', message: 'displayName must be a non-empty string.', fieldPath: ['displayName'] });
  for (const field of ['homepage', 'repository'] as const) {
    /** 两个公开链接复用完全相同的 HTTP(S) 边界。 */
    const candidate = values[field]?.value;
    if (candidate !== undefined && (typeof candidate !== 'string' || !isHttpUrl(candidate)))
      diagnostics.report('config', { code: `CONFIG_${field.toUpperCase()}_INVALID`, severity: 'error', message: `${field} must be an absolute HTTP URL.`, fieldPath: [field] });
  }
  /** license 保留 SPDX 表达式而不是猜测或改写许可证。 */
  const license = values.license?.value;
  if (license !== undefined) {
    try {
      if (typeof license !== 'string' || license.length === 0)
        throw new TypeError('invalid');
      parseSpdxExpression(license);
    } catch {
      diagnostics.report('config', { code: 'CONFIG_LICENSE_INVALID', severity: 'error', message: 'license must be a valid SPDX expression.', fieldPath: ['license'] });
    }
  }

  /** build 先解析，以便 Public overlap 使用最终 outDir。 */
  const build = values.build === undefined ? {} : descriptors(values.build.value, 'build', diagnostics, ['build']) ?? {};
  unknownFields(build, new Set(['outDir', 'strict']), diagnostics, ['build']);
  if (build.strict !== undefined && typeof build.strict.value !== 'boolean')
    diagnostics.report('config', { code: 'CONFIG_STRICT_INVALID', severity: 'error', message: 'build.strict must be boolean.', fieldPath: ['build', 'strict'] });
  /** strict 默认开启，Platform 可在定义层显式覆盖。 */
  const strict = typeof build.strict?.value === 'boolean' ? build.strict.value : true;
  /** 作者源码目录始终解析为工程内绝对 Kernel 路径。 */
  const srcDirectory = projectPath(projectRoot, values.srcDir?.value, 'src', 'srcDir', diagnostics);
  /** 输出目录由事务层完整托管且不得与源码重叠。 */
  const outDirectory = projectPath(projectRoot, build.outDir?.value, 'dist', 'build.outDir', diagnostics);
  if (outDirectory === projectRoot || overlaps(srcDirectory, outDirectory))
    diagnostics.report('config', { code: 'CONFIG_DIRECTORY_OVERLAP', severity: 'error', message: 'srcDir and build.outDir must be separate project subtrees.' });
  /** Public 需要同时避开源码、输出和配置入口。 */
  const resolvedPublic = publicConfig(projectRoot, values.public?.value, [srcDirectory, outDirectory, configFile], diagnostics);
  /** Runtime 始终以最终 srcDirectory 为约定根。 */
  const resolvedRuntime = runtimeConfig(srcDirectory, values.runtime?.value, diagnostics);

  /** Platform definitions 必须显式、非空、品牌有效且 ID 唯一。 */
  const platforms: ResolvedPlatform[] = [];
  if (!Array.isArray(values.platforms?.value) || values.platforms.value.length === 0) {
    diagnostics.report('config', { code: 'CONFIG_PLATFORMS_REQUIRED', severity: 'error', message: 'platforms must contain at least one Platform.', fieldPath: ['platforms'] });
  } else {
    /** Platform ID 集合用于拒绝重复目标。 */
    const seen = new Set<string>();
    for (const [index, candidate] of [...values.platforms.value].entries()) {
      if (!isAcpluginPlatform(candidate)) {
        diagnostics.report('config', { code: 'CONFIG_PLATFORM_INVALID', severity: 'error', message: 'Every platform must be created by definePlatform().', fieldPath: ['platforms', index] });
        continue;
      }
      if (seen.has(candidate.id)) {
        diagnostics.report('config', { code: 'CONFIG_PLATFORM_DUPLICATE', severity: 'error', message: `Platform "${candidate.id}" is configured more than once.`, fieldPath: ['platforms', index] });
        continue;
      }
      seen.add(candidate.id);
      platforms.push(Object.freeze({ definition: candidate, strict: candidate.strict ?? strict }));
    }
  }
  /** Extension 定义同样只接受品牌实例并按 ID 去重。 */
  const extensions: AcpluginExtension[] = [];
  if (values.extensions !== undefined) {
    if (!Array.isArray(values.extensions.value)) {
      diagnostics.report('config', { code: 'CONFIG_EXTENSIONS_INVALID', severity: 'error', message: 'extensions must be an array.', fieldPath: ['extensions'] });
    } else {
      /** Extension ID 集合用于稳定拒绝重复能力。 */
      const seen = new Set<string>();
      for (const [index, candidate] of [...values.extensions.value].entries()) {
        if (!isAcpluginExtension(candidate)) {
          diagnostics.report('config', { code: 'CONFIG_EXTENSION_INVALID', severity: 'error', message: 'Every extension must be created by defineExtension().', fieldPath: ['extensions', index] });
          continue;
        }
        if (seen.has(candidate.id)) {
          diagnostics.report('config', { code: 'CONFIG_EXTENSION_DUPLICATE', severity: 'error', message: `Extension "${candidate.id}" is configured more than once.`, fieldPath: ['extensions', index] });
          continue;
        }
        seen.add(candidate.id);
        extensions.push(candidate);
      }
    }
  }
  /** 可选 metadata 也必须在其他字段失败时独立收集诊断。 */
  const resolvedAuthor = author(values.author?.value, diagnostics);
  /** keyword 解析与作者输入容器断开并完成稳定去重。 */
  const resolvedKeywords = keywords(values.keywords?.value, diagnostics);
  if (diagnostics.hasErrors)
    return { diagnostics: diagnostics.diagnostics };

  /** metadata 必需字段已证明有效；完整 snapshot 递归冻结。 */
  const metadata = Object.freeze({
    name: name as string,
    version: version as string,
    description: (description as string).trim(),
    ...(typeof displayName === 'string' ? { displayName: displayName.trim() } : {}),
    ...(resolvedAuthor === undefined ? {} : { author: resolvedAuthor }),
    ...(typeof values.homepage?.value === 'string' ? { homepage: values.homepage.value } : {}),
    ...(typeof values.repository?.value === 'string' ? { repository: values.repository.value } : {}),
    ...(typeof license === 'string' ? { license } : {}),
    keywords: resolvedKeywords,
  }) satisfies Readonly<PluginMetadata>;
  /** 最终 config 只在所有独立诊断均通过后物化。 */
  const config: ResolvedKernelConfig = Object.freeze({
    projectRoot,
    configFile,
    command: options.command,
    mode: options.mode,
    metadata,
    srcDirectory,
    public: resolvedPublic,
    runtime: resolvedRuntime,
    platforms: Object.freeze(platforms),
    extensions: Object.freeze(extensions),
    outDirectory,
    strict,
  });
  return { config, diagnostics: diagnostics.diagnostics };
}
