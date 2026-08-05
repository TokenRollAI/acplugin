import path from 'node:path';
import semver from 'semver';
import type {
  BuildCommand,
  BuildMode,
  PlatformExtensions,
  ResolvedConfig,
  ResolvedPublicConfig,
  ResolvedTarget,
  TargetId,
  UserConfig,
} from './types.js';
import { TARGET_IDS } from './types.js';
import { DiagnosticCollector } from './diagnostics.js';
import { extensionIssues } from './extensions.js';

/** Plugin 名称允许使用的小写 kebab-case 格式。 */
const NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Module 名称允许使用的普通包名或 npm scope 包名格式。 */
const MODULE_NAME_PATTERN = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;

/** 顶层配置唯一允许出现的字段，未知字段必须诊断为错误。 */
const ALLOWED_FIELDS = new Set([
  'name', 'version', 'description', 'displayName', 'srcDir', 'public',
  'targets', 'modules', 'build', 'extensions',
]);

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
  // Set 让字段检查保持确定性的同时避免每次查找都遍历数组。
  const accepted = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!accepted.has(key)) {
      diagnostics.error('CONFIG_FIELD_UNKNOWN', `Unknown configuration field "${[...fieldPath, key].join('.')}` + '".', {
        phase: 'config', fieldPath: [...fieldPath, key],
      });
    }
  }
}

/**
 * 从规范名称推导适合界面展示的默认名称。
 *
 * @param name 已通过 kebab-case 校验的 Plugin 名称。
 * @returns 将每个名称片段首字母大写后的展示名称。
 */
function presentationName(name: string): string {
  return name.split('-').map(part => part.charAt(0).toUpperCase() + part.slice(1)).join(' ');
}

/**
 * 判断候选绝对路径是否位于指定根目录内。
 *
 * @param root 可信工程根目录。
 * @param candidate 需要验证的候选绝对路径。
 * @returns 候选路径等于或包含于根目录时返回 true。
 */
function isInside(root: string, candidate: string): boolean {
  // 只使用 lexical relative 结果，后续文件读取阶段还会验证真实文件类型。
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

/**
 * 将用户路径解析为绝对路径，并诊断越出工程根目录的配置。
 *
 * @param root 可信工程根目录。
 * @param value 用户提供的相对路径。
 * @param field 产生该路径的配置字段。
 * @param diagnostics 用于记录路径逃逸的诊断容器。
 * @returns 规范化后的绝对路径；即使非法也返回值以继续收集其他错误。
 */
function resolveInside(root: string, value: string, field: string, diagnostics: DiagnosticCollector): string {
  // 保留解析结果可以让一次 validate 报告尽可能多的独立配置问题。
  const resolved = path.resolve(root, value);
  if (!isInside(root, resolved)) {
    diagnostics.error('CONFIG_PATH_ESCAPE', `${field} must stay inside the project root.`, {
      phase: 'config', fieldPath: [field],
    });
  }
  return resolved;
}

/**
 * 合并目标平台默认值并拒绝未知、重复或空目标列表。
 *
 * @param targets 用户配置的目标平台数组，缺省时使用全部内置目标。
 * @param strict 全局兼容性严格度默认值。
 * @param diagnostics 用于收集目标配置错误的诊断容器。
 * @returns 去重且带有最终严格度的目标配置。
 */
function resolveTargets(
  targets: readonly unknown[] | undefined,
  strict: boolean,
  diagnostics: DiagnosticCollector,
): ResolvedTarget[] {
  // 默认同时编译 Claude Code 和 Codex，保持最小配置即可多平台输出。
  const input: readonly unknown[] = targets ?? TARGET_IDS;
  // 已解析标识用于拒绝同一目标的重复配置。
  const seen = new Set<TargetId>();
  // 结果只收集结构和标识均合法的目标。
  const resolved: ResolvedTarget[] = [];

  if (input.length === 0)
    diagnostics.error('CONFIG_TARGETS_EMPTY', 'targets must contain at least one target.', { phase: 'config', fieldPath: ['targets'] });

  for (const target of input) {
    if (typeof target !== 'string' && !isRecord(target)) {
      diagnostics.error('CONFIG_TARGET_INVALID', 'Every target must be a target ID or target object.', { phase: 'config', fieldPath: ['targets'] });
      continue;
    }
    if (isRecord(target)) {
      rejectUnknownFields(target, ['id', 'strict'], ['targets'], diagnostics);
      if (target.strict !== undefined && typeof target.strict !== 'boolean')
        diagnostics.error('CONFIG_TARGET_STRICT_INVALID', 'Target strict must be boolean.', { phase: 'config', fieldPath: ['targets', 'strict'] });
    }
    // 字符串简写和对象形式最终都归一为同一个目标标识。
    const id = typeof target === 'string' ? target : target.id;
    if (typeof id !== 'string') {
      diagnostics.error('CONFIG_TARGET_INVALID', 'Target id must be a string.', { phase: 'config', fieldPath: ['targets', 'id'] });
      continue;
    }
    if (!TARGET_IDS.includes(id as TargetId)) {
      diagnostics.error('CONFIG_TARGET_UNKNOWN', `Unknown target "${id}".`, { phase: 'config', fieldPath: ['targets'] });
      continue;
    }
    if (seen.has(id as TargetId)) {
      diagnostics.error('CONFIG_TARGET_DUPLICATE', `Target "${id}" is duplicated.`, { phase: 'config', fieldPath: ['targets'] });
      continue;
    }
    seen.add(id as TargetId);
    resolved.push({ id: id as TargetId, strict: typeof target === 'string' || typeof target.strict !== 'boolean' ? strict : target.strict });
  }

  return resolved;
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

  // undefined 等价于启用默认 public 目录的空配置对象。
  const object = value ?? {};
  rejectUnknownFields(object, ['dir', 'copy'], ['public'], diagnostics);
  if (object.dir !== undefined && typeof object.dir !== 'string')
    diagnostics.error('CONFIG_PUBLIC_DIR_INVALID', 'public.dir must be a string.', { phase: 'config', fieldPath: ['public', 'dir'] });
  // Public 来源目录必须在工程根目录内，目标路径则由每条 copy 规则决定。
  const dir = resolveInside(root, typeof object.dir === 'string' ? object.dir : 'public', 'public.dir', diagnostics);
  // 仅保留字段类型完整的规则，非法规则由诊断表达而不进入后续扫描。
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
      if (typeof rawRule.from !== 'string' || typeof rawRule.to !== 'string') {
        diagnostics.error('CONFIG_PUBLIC_RULE_INVALID', 'Public copy rules require string from and to fields.', { phase: 'config', fieldPath: ['public', 'copy', index] });
        continue;
      }
      // 先保存稳定的字符串形态，再执行绝对路径和父目录穿越检查。
      const rule = { from: rawRule.from, to: rawRule.to };
      copy.push(rule);
      if (path.isAbsolute(rule.from) || path.isAbsolute(rule.to) || rule.from.split(/[\\/]/).includes('..') || rule.to.split(/[\\/]/).includes('..')) {
        diagnostics.error('CONFIG_PUBLIC_RULE_ESCAPE', 'Public copy paths must be relative and cannot contain parent traversal.', {
          phase: 'config', fieldPath: ['public', 'copy', index],
        });
      }
    }
  }
  return object.copy !== undefined ? { enabled: true, dir, copy } : { enabled: true, dir };
}

/**
 * 将用户配置严格校验并解析为 Core 可直接消费的配置。
 *
 * @param value 从可信 `acplugin.config.ts` 加载的用户配置对象。
 * @param configPath 配置文件绝对路径或可解析路径。
 * @param command 当前执行的 CLI 构建命令。
 * @param mode 当前构建运行模式。
 * @returns 成功时包含完整配置；失败时只返回已脱敏、可排序的诊断。
 */
export function resolveConfig(
  value: UserConfig,
  configPath: string,
  command: BuildCommand,
  mode: BuildMode,
): { config?: ResolvedConfig; diagnostics: readonly import('./types.js').Diagnostic[] } {
  // 单次解析共享同一个 Collector，以便用户一次看到全部独立配置问题。
  const diagnostics = new DiagnosticCollector();
  // 配置文件所在目录定义所有工程相对路径的信任根。
  const root = path.dirname(path.resolve(configPath));
  // 先降级为 unknown，确保运行时校验不依赖调用方的静态类型声明。
  const object = value as unknown;

  if (!isRecord(object)) {
    diagnostics.error('CONFIG_OBJECT_REQUIRED', 'Configuration must be an object.', { phase: 'config' });
    return { diagnostics: diagnostics.diagnostics };
  }

  rejectUnknownFields(object, [...ALLOWED_FIELDS], [], diagnostics);

  if (typeof object.name !== 'string' || !NAME_PATTERN.test(object.name))
    diagnostics.error('CONFIG_NAME_INVALID', 'name must be lowercase kebab-case.', { phase: 'config', fieldPath: ['name'] });
  if (typeof object.version !== 'string' || !semver.valid(object.version))
    diagnostics.error('CONFIG_VERSION_INVALID', 'version must be valid SemVer.', { phase: 'config', fieldPath: ['version'] });
  if (typeof object.description !== 'string' || object.description.trim() === '')
    diagnostics.error('CONFIG_DESCRIPTION_REQUIRED', 'description is required.', { phase: 'config', fieldPath: ['description'] });
  if (object.displayName !== undefined && (typeof object.displayName !== 'string' || object.displayName.trim() === ''))
    diagnostics.error('CONFIG_DISPLAY_NAME_INVALID', 'displayName must be a non-empty string.', { phase: 'config', fieldPath: ['displayName'] });
  if (object.srcDir !== undefined && typeof object.srcDir !== 'string')
    diagnostics.error('CONFIG_SRC_DIR_INVALID', 'srcDir must be a string.', { phase: 'config', fieldPath: ['srcDir'] });

  // 非法 build 值不会进入后续字段读取，但仍继续收集其他顶层错误。
  let build: Record<string, unknown> = {};
  if (object.build !== undefined) {
    if (!isRecord(object.build))
      diagnostics.error('CONFIG_BUILD_INVALID', 'build must be an object.', { phase: 'config', fieldPath: ['build'] });
    else
      build = object.build;
  }
  rejectUnknownFields(build, ['outDir', 'strict'], ['build'], diagnostics);
  if (build.outDir !== undefined && typeof build.outDir !== 'string')
    diagnostics.error('CONFIG_OUT_DIR_INVALID', 'build.outDir must be a string.', { phase: 'config', fieldPath: ['build', 'outDir'] });
  if (build.strict !== undefined && typeof build.strict !== 'boolean')
    diagnostics.error('CONFIG_STRICT_INVALID', 'build.strict must be boolean.', { phase: 'config', fieldPath: ['build', 'strict'] });

  if (object.targets !== undefined && !Array.isArray(object.targets))
    diagnostics.error('CONFIG_TARGETS_INVALID', 'targets must be an array.', { phase: 'config', fieldPath: ['targets'] });
  if (object.modules !== undefined && !Array.isArray(object.modules))
    diagnostics.error('CONFIG_MODULES_INVALID', 'modules must be an array.', { phase: 'config', fieldPath: ['modules'] });

  // 扩展数据必须保持确定性 JSON，且不能覆盖 Core 的规范语义字段。
  let extensions: PlatformExtensions = {};
  if (object.extensions !== undefined) {
    if (!isRecord(object.extensions)) {
      diagnostics.error('CONFIG_EXTENSIONS_INVALID', 'extensions must be an object.', { phase: 'config', fieldPath: ['extensions'] });
    } else {
      rejectUnknownFields(object.extensions, [...TARGET_IDS], ['extensions'], diagnostics);
      for (const [target, extension] of Object.entries(object.extensions)) {
        if (!TARGET_IDS.includes(target as TargetId))
          continue;
        if (!isRecord(extension)) {
          diagnostics.error('CONFIG_EXTENSION_INVALID', `extensions.${target} must be an object.`, { phase: 'config', fieldPath: ['extensions', target] });
          continue;
        }
        for (const issue of extensionIssues(extension, ['extensions', target]))
          diagnostics.error('CONFIG_EXTENSION_SEMANTICS', issue.message, { phase: 'config', fieldPath: issue.path });
      }
      extensions = object.extensions as PlatformExtensions;
    }
  }

  // 严格模式默认开启，避免平台降级在未明确授权时静默发生。
  const strict = typeof build.strict === 'boolean' ? build.strict : true;
  // 所有运行路径在进入 Scanner 前统一解析为工程内绝对路径。
  const srcDir = resolveInside(root, typeof object.srcDir === 'string' ? object.srcDir : 'src', 'srcDir', diagnostics);
  // 输出目录独立解析，随后还会检查它与来源目录之间的包含关系。
  const outDir = resolveInside(root, typeof build.outDir === 'string' ? build.outDir : 'dist', 'build.outDir', diagnostics);
  // Public 和 Target 子配置分别负责自己的默认值与结构诊断。
  const publicConfig = resolvePublic(root, object.public, diagnostics);
  const targets = resolveTargets(Array.isArray(object.targets) ? object.targets : object.targets === undefined ? undefined : [], strict, diagnostics);

  if (outDir === root)
    diagnostics.error('CONFIG_OUTDIR_ROOT', 'build.outDir cannot be the project root.', { phase: 'config', fieldPath: ['build', 'outDir'] });
  if (srcDir === outDir || (isInside(srcDir, outDir) && srcDir !== outDir) || (isInside(outDir, srcDir) && srcDir !== outDir))
    diagnostics.error('CONFIG_DIRECTORY_OVERLAP', 'srcDir and build.outDir cannot contain each other.', { phase: 'config' });
  if (publicConfig.enabled && (publicConfig.dir === outDir || isInside(publicConfig.dir, outDir) || isInside(outDir, publicConfig.dir)))
    diagnostics.error('CONFIG_DIRECTORY_OVERLAP', 'Public directory and build.outDir cannot contain each other.', { phase: 'config' });

  // Module 保持用户声明顺序；真正的依赖拓扑排序由 Builder 统一执行。
  const modules = (Array.isArray(object.modules) ? object.modules : []) as unknown[];
  // 名称集合用于在配置边界提前拒绝同一 Module 的重复实例。
  const moduleNames = new Set<string>();
  for (const [index, module] of modules.entries()) {
    if (!isRecord(module) || typeof module.name !== 'string' || !MODULE_NAME_PATTERN.test(module.name)) {
      diagnostics.error('CONFIG_MODULE_INVALID', 'Every module name must be a lowercase package-style identifier.', { phase: 'config', fieldPath: ['modules', index] });
      continue;
    }
    rejectUnknownFields(module, [
      'name', 'dependsOn', 'configResolved', 'discover', 'validate', 'build', 'generate', 'buildEnd',
    ], ['modules', index], diagnostics);
    if (module.dependsOn !== undefined && (!Array.isArray(module.dependsOn) || module.dependsOn.some(dependency => typeof dependency !== 'string' || dependency === '')))
      diagnostics.error('CONFIG_MODULE_DEPENDENCIES_INVALID', 'Module dependsOn must be an array of non-empty names.', { phase: 'config', fieldPath: ['modules', index, 'dependsOn'] });
    for (const hook of ['configResolved', 'discover', 'validate', 'build', 'generate', 'buildEnd']) {
      if (module[hook] !== undefined && typeof module[hook] !== 'function')
        diagnostics.error('CONFIG_MODULE_HOOK_INVALID', `Module ${hook} must be a function.`, { phase: 'config', fieldPath: ['modules', index, hook] });
    }
    if (moduleNames.has(module.name))
      diagnostics.error('CONFIG_MODULE_DUPLICATE', `Module "${module.name}" is configured more than once.`, { phase: 'config', fieldPath: ['modules', index] });
    moduleNames.add(module.name);
  }

  if (diagnostics.hasErrors)
    return { diagnostics: diagnostics.diagnostics };

  // 只有不存在错误诊断时才构造类型完备的 ResolvedConfig。
  const config: ResolvedConfig = {
    root,
    configPath: path.resolve(configPath),
    command,
    mode,
    name: object.name as string,
    version: object.version as string,
    description: (object.description as string).trim(),
    displayName: typeof object.displayName === 'string' ? object.displayName.trim() : presentationName(object.name as string),
    srcDir,
    public: publicConfig,
    targets,
    modules: modules as import('./types.js').AcpluginModule[],
    outDir,
    strict,
    extensions,
  };
  return { config, diagnostics: diagnostics.diagnostics };
}
