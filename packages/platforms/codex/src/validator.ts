import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { JsonValue, PlatformValidateContext } from '@tokenroll/acplugin';
import { imageSize } from 'image-size';
import { parseDocument } from 'yaml';
import { MARKETPLACE_MANIFEST_PATH, PLUGIN_MANIFEST_PATH } from './manifest.js';
import {
  CODEX_BRAND_COLOR_PATTERN,
  CODEX_CATEGORIES,
  CODEX_INTERFACE_FIELDS,
  CODEX_INTERFACE_REQUIRED_FIELDS,
  CODEX_MARKETPLACE_INSTALLATIONS,
  CODEX_SKILL_PRODUCTS,
  codexInterfaceFieldIssue,
  isCodexHttpsUrl,
  parseCodexSvgDimensions,
} from './protocol.js';

/** Codex Plugin Manifest 允许出现的当前官方根字段。 */
const PLUGIN_FIELDS = new Set([
  'id', 'name', 'version', 'description', 'author', 'homepage', 'repository', 'license', 'keywords',
  'skills', 'mcpServers', 'apps', 'hooks', 'interface',
]);

/** Codex Plugin `interface` 允许出现的当前官方字段。 */
const INTERFACE_FIELDS = new Set<string>(CODEX_INTERFACE_FIELDS);

/** Codex Skill `agents/openai.yaml` 允许出现的根字段。 */
const SKILL_METADATA_FIELDS = new Set(['interface', 'policy', 'dependencies']);

/** Codex Skill 元数据 `interface` 允许出现的 snake_case 字段。 */
const SKILL_INTERFACE_FIELDS = new Set([
  'display_name', 'short_description', 'icon_small', 'icon_large', 'brand_color', 'default_prompt',
]);

/**
 * 按 UTF-16 code unit 比较 Codex Skill ID，不依赖宿主 locale/ICU。
 *
 * @param left 左侧 ID。
 * @param right 右侧 ID。
 * @returns 与 Array.sort 约定一致的 -1、0 或 1。
 */
function compareCodeUnits(left: string, right: string): number {
  if (left === right)
    return 0;
  return left < right ? -1 : 1;
}

/** Codex Skill 元数据 `policy` 允许出现的字段。 */
const SKILL_POLICY_FIELDS = new Set(['products', 'allow_implicit_invocation']);

/** Codex Skill 元数据支持的产品范围。 */
const SKILL_PRODUCTS = new Set<string>(CODEX_SKILL_PRODUCTS);

/** Codex Marketplace 根清单允许出现的字段。 */
const MARKETPLACE_FIELDS = new Set(['name', 'interface', 'plugins']);

/** Codex Marketplace 每个 Plugin 条目允许出现的字段。 */
const MARKETPLACE_PLUGIN_FIELDS = new Set(['name', 'source', 'policy', 'category']);

/** Codex Marketplace 当前支持的安装策略。 */
const INSTALLATION_POLICIES = new Set<string>(CODEX_MARKETPLACE_INSTALLATIONS);

/** Codex 官方插件目录当前接受的分类。 */
const CATEGORIES = new Set<string>(CODEX_CATEGORIES);

/** Codex Plugin 名称允许使用的官方 ASCII 规则。 */
const PLUGIN_NAME_PATTERN = /^[\dA-Za-z][\dA-Za-z_-]*$/;

/** 保守验证完整 Semantic Version 的规则。 */
const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[\dA-Za-z-]+(?:\.[\dA-Za-z-]+)*)?(?:\+[\dA-Za-z-]+(?:\.[\dA-Za-z-]+)*)?$/;

/** Canonical 与 fallback Skill 最终目录使用的小写 kebab-case 规则。 */
const SKILL_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** 多 Plugin Marketplace 的本地来源必须使用稳定单元目录。 */
const MARKETPLACE_PLUGIN_SOURCE_PATTERN = /^\.\/plugins\/[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Codex 目录品牌图片支持的文件扩展名。 */
const BRANDING_IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.svg']);

/** Codex 目录品牌图片允许的最大字节数。 */
const MAX_BRANDING_IMAGE_BYTES = 5 * 1024 * 1024;

/** Codex 当前公开并可以从 Plugin 生命周期配置触发的 Hook 事件。 */
const HOOK_EVENTS = new Set([
  'SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PreToolUse', 'PermissionRequest', 'PostToolUse',
  'PreCompact', 'PostCompact', 'SubagentStart', 'SubagentStop', 'Stop',
]);

/** Codex `hooks.json` 顶层允许出现的字段。 */
const HOOK_CONFIG_FIELDS = new Set(['description', 'hooks']);

/** 单个 Codex Hook matcher 分组允许出现的字段。 */
const HOOK_GROUP_FIELDS = new Set(['matcher', 'hooks']);

/** 当前可执行 Codex command Hook Handler 允许出现的字段。 */
const HOOK_HANDLER_FIELDS = new Set([
  'type', 'command', 'commandWindows', 'command_windows', 'timeout', 'statusMessage',
  'additionalContextLimit', 'async',
]);

/** JSON 对象的运行时可索引类型。 */
type JsonRecord = Record<string, JsonValue>;

/**
 * 判断未知值是否为非数组 JSON 对象。
 *
 * @param value 从候选清单解析的未知值。
 * @returns 可以按字段读取时返回 true。
 */
function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * 向 Core 提交 Codex 候选校验错误。
 *
 * @param context Platform validateBundle 生命周期上下文。
 * @param code 稳定诊断码。
 * @param message 不包含宿主绝对路径的错误信息。
 * @param fieldPath 可选的清单字段位置。
 */
function report(
  context: PlatformValidateContext,
  code: string,
  message: string,
  fieldPath?: readonly (string | number)[],
): void {
  context.reportDiagnostic({
    code,
    severity: 'error',
    message,
    ...(fieldPath === undefined ? {} : { fieldPath }),
  });
}

/**
 * 从候选安装根读取并解析 JSON 文件。
 *
 * @param context Platform validateBundle 生命周期上下文。
 * @param artifactPath 候选根内的规范 Artifact 路径。
 * @returns JSON 对象；缺失或格式错误时提交诊断并返回 undefined。
 */
async function readJson(
  context: PlatformValidateContext,
  artifactPath: string,
): Promise<JsonRecord | undefined> {
  try {
    /** 从 Core 已安全物化的候选根读取清单文本。 */
    const source = await fs.readFile(path.join(context.candidate.root, artifactPath), 'utf8');
    /** JSON.parse 的未知结果仍需验证顶层对象形态。 */
    const value: unknown = JSON.parse(source);
    if (!isRecord(value)) {
      report(context, 'CODEX_MANIFEST_OBJECT_REQUIRED', `${artifactPath} must contain a JSON object.`);
      return undefined;
    }
    return value;
  } catch {
    report(context, 'CODEX_MANIFEST_READ_FAILED', `${artifactPath} must be present and contain valid JSON.`);
    return undefined;
  }
}

/**
 * 解析 YAML 并要求顶层为普通映射。
 *
 * @param context Platform validateBundle 生命周期上下文。
 * @param source 待解析的 YAML 文本。
 * @param artifactPath 用于稳定诊断的相对 Artifact 路径。
 * @returns 无语法错误的 JSON 兼容对象，否则返回 undefined。
 */
function parseYamlObject(
  context: PlatformValidateContext,
  source: string,
  artifactPath: string,
): JsonRecord | undefined {
  try {
    /** 保留 YAML parser errors 以拒绝重复键和其他不规范输入。 */
    const document = parseDocument(source, { uniqueKeys: true });
    if (document.errors.length > 0)
      throw new Error('Malformed YAML.');
    /** YAML 文档转换后的未知顶层值。 */
    const value: unknown = document.toJSON();
    if (!isRecord(value)) {
      report(context, 'CODEX_YAML_OBJECT_REQUIRED', `${artifactPath} must contain a YAML mapping.`);
      return undefined;
    }
    return value;
  } catch {
    report(context, 'CODEX_YAML_INVALID', `${artifactPath} must contain valid YAML.`);
    return undefined;
  }
}

/**
 * 判断清单路径引用是否严格位于当前 Plugin 安装根。
 *
 * @param reference Codex Manifest 中的相对路径。
 * @returns 路径使用 `./`、不逃逸且不指向根本身时返回 true。
 */
function isSafePluginReference(reference: string): boolean {
  if (!reference.startsWith('./') || reference.includes('\\') || reference.includes('\0'))
    return false;
  /** 去掉协议前缀后执行 POSIX 规范化的路径片段。 */
  const relative = reference.slice(2);
  /** 规范化路径用于拒绝空引用和父目录逃逸。 */
  const normalized = path.posix.normalize(relative);
  return relative.length > 0
    && normalized !== '.'
    && normalized !== '..'
    && !normalized.startsWith('../')
    && !path.posix.isAbsolute(normalized);
}

/**
 * 判断 Artifact 集合是否包含被引用文件或目录。
 *
 * @param artifacts 当前 DeliveryUnit 的规范路径集合。
 * @param reference 已通过安全规则验证的 Manifest 引用。
 * @returns 精确文件或目录前缀存在时返回 true。
 */
function referenceExists(artifacts: ReadonlySet<string>, reference: string): boolean {
  /** 清单引用去掉 `./` 和结尾斜线后的 Artifact 路径。 */
  const target = reference.slice(2).replace(/\/+$/u, '');
  if (artifacts.has(target))
    return true;
  for (const artifact of artifacts) {
    if (artifact.startsWith(`${target}/`))
      return true;
  }
  return false;
}

/**
 * 把 Distribution 中某个 Plugin 子树转换为安装根相对 Artifact 集合。
 *
 * @param context Platform validateBundle 生命周期上下文。
 * @param pluginRoot Plugin 相对于 Distribution 根的无前导点路径。
 * @returns 去掉 Plugin 根前缀后的 Artifact 路径集合。
 */
function scopedArtifacts(context: PlatformValidateContext, pluginRoot: string): ReadonlySet<string> {
  /** 根 Plugin 不需要过滤或裁剪路径。 */
  if (pluginRoot === '')
    return new Set(context.candidate.unit.artifacts.map(artifact => artifact.path));
  /** 嵌套 Plugin 全部 Artifact 共同使用的固定目录前缀。 */
  const prefix = `${pluginRoot}/`;
  return new Set(context.candidate.unit.artifacts
    .filter(artifact => artifact.path.startsWith(prefix))
    .map(artifact => artifact.path.slice(prefix.length)));
}

/**
 * 校验单个 Manifest 路径的安全性与存在性。
 *
 * @param context Platform validateBundle 生命周期上下文。
 * @param artifacts 当前 DeliveryUnit 的 Artifact 路径集合。
 * @param field 当前引用所属字段。
 * @param reference 待校验路径。
 * @param fieldPath 精确诊断位置。
 */
function validateReference(
  context: PlatformValidateContext,
  artifacts: ReadonlySet<string>,
  field: string,
  reference: string,
  fieldPath: readonly (string | number)[],
): void {
  if (!isSafePluginReference(reference)) {
    report(context, 'CODEX_MANIFEST_REFERENCE_UNSAFE', `${field} must start with ./ and stay inside the Plugin root.`, fieldPath);
  } else if (!referenceExists(artifacts, reference)) {
    report(context, 'CODEX_MANIFEST_REFERENCE_MISSING', `${field} references a missing Plugin file or directory.`, fieldPath);
  }
}

/**
 * 校验已存在的 Codex 目录品牌图片格式、字节数和方形尺寸。
 *
 * @param context Platform validateBundle 生命周期上下文。
 * @param pluginRoot Plugin 相对于候选 Distribution 根的安装目录。
 * @param reference 相对于 Plugin 根的图片路径。
 * @param field Manifest 中声明图片的字段。
 * @param fieldPath 精确诊断位置。
 */
async function validateBrandingImage(
  context: PlatformValidateContext,
  pluginRoot: string,
  reference: string,
  field: string,
  fieldPath: readonly (string | number)[],
): Promise<void> {
  if (!isSafePluginReference(reference))
    return;
  /** Manifest 引用转换后的候选根内 Artifact 路径。 */
  const artifactPath = reference.slice(2);
  /** 图片文件名的规范小写扩展名。 */
  const extension = path.posix.extname(artifactPath).toLocaleLowerCase('en-US');
  if (!BRANDING_IMAGE_EXTENSIONS.has(extension)) {
    report(context, 'CODEX_BRANDING_IMAGE_FORMAT_UNSUPPORTED', `${field} must use PNG, JPEG, WebP, or SVG.`, fieldPath);
    return;
  }
  try {
    /** 从 Core 已物化的候选根读取实际图片字节。 */
    const bytes = await fs.readFile(path.join(context.candidate.root, pluginRoot, artifactPath));
    if (bytes.byteLength > MAX_BRANDING_IMAGE_BYTES) {
      report(context, 'CODEX_BRANDING_IMAGE_TOO_LARGE', `${field} must not exceed 5 MiB.`, fieldPath);
      return;
    }
    /** SVG 与 Raster 解析后统一参与方形和范围校验的尺寸。 */
    let dimensions: { readonly width?: number; readonly height?: number };
    if (extension === '.svg') {
      dimensions = parseCodexSvgDimensions(bytes);
    } else {
      /** Raster 继续使用二进制格式探测与安全解码。 */
      const raster = imageSize(bytes);
      /** `.jpeg` 与 image-size 返回的 `jpg` 使用同一检测格式。 */
      const expectedType = extension === '.jpeg' ? 'jpg' : extension.slice(1);
      if (raster.type !== expectedType) {
        report(context, 'CODEX_BRANDING_IMAGE_CONTENT_MISMATCH', `${field} extension must match the detected image format.`, fieldPath);
      }
      dimensions = raster;
    }
    if (dimensions.width === undefined || dimensions.height === undefined
      || dimensions.width !== dimensions.height
      || dimensions.width < 48
      || dimensions.width > 4_096) {
      report(context, 'CODEX_BRANDING_IMAGE_DIMENSIONS_INVALID', `${field} must be a square image between 48 and 4096 pixels.`, fieldPath);
    }
  } catch {
    report(context, 'CODEX_BRANDING_IMAGE_DECODE_FAILED', `${field} must reference a readable, decodable image.`, fieldPath);
  }
}

/**
 * 校验 Codex Plugin 安装界面字段和资源引用。
 *
 * @param context Platform validateBundle 生命周期上下文。
 * @param artifacts 当前 DeliveryUnit 的 Artifact 路径集合。
 * @param pluginRoot Plugin 相对于候选 Distribution 根的安装目录。
 * @param value Manifest 的 interface 候选。
 */
async function validateInterface(
  context: PlatformValidateContext,
  artifacts: ReadonlySet<string>,
  pluginRoot: string,
  value: JsonValue,
): Promise<void> {
  if (!isRecord(value)) {
    report(context, 'CODEX_INTERFACE_OBJECT_REQUIRED', 'interface must be a JSON object.', ['interface']);
    return;
  }
  for (const field of Object.keys(value)) {
    if (!INTERFACE_FIELDS.has(field))
      report(context, 'CODEX_INTERFACE_FIELD_UNKNOWN', `Unknown Codex interface field "${field}".`, ['interface', field]);
  }
  /** 已报告纯值问题的字段不再进入资源存在性校验。 */
  const invalidFields = new Set<string>();
  for (const field of CODEX_INTERFACE_FIELDS) {
    /** 当前最终 interface 字段候选。 */
    const candidate = value[field];
    /** 当前字段是否属于 interface 存在时的四个必填展示字段。 */
    const required = (CODEX_INTERFACE_REQUIRED_FIELDS as readonly string[]).includes(field);
    /** 必填字段缺失、类型错误或空白时只报告必填问题。 */
    const requiredInvalid = required && (typeof candidate !== 'string' || candidate.trim().length === 0);
    if (candidate === undefined || requiredInvalid) {
      if (required) {
        report(context, 'CODEX_INTERFACE_FIELD_REQUIRED', `interface.${field} must be a non-empty string.`, ['interface', field]);
        invalidFields.add(field);
      }
      continue;
    }
    /** 共享纯规则返回的第一个稳定问题。 */
    const issue = codexInterfaceFieldIssue(field, candidate);
    if (issue !== undefined) {
      report(context, issue.code, issue.message, ['interface', field]);
      invalidFields.add(field);
    }
  }
  for (const field of ['composerIcon', 'logo'] as const) {
    /** 当前图片路径候选。 */
    const candidate = value[field];
    if (typeof candidate === 'string' && !invalidFields.has(field)) {
      validateReference(context, artifacts, `interface.${field}`, candidate, ['interface', field]);
      if (referenceExists(artifacts, candidate))
        await validateBrandingImage(context, pluginRoot, candidate, `interface.${field}`, ['interface', field]);
    }
  }
  if (Array.isArray(value.screenshots) && !invalidFields.has('screenshots')) {
    for (const [index, screenshot] of value.screenshots.entries())
      validateReference(context, artifacts, 'interface.screenshots', screenshot as string, ['interface', 'screenshots', index]);
  }
}

/**
 * 校验 Codex Hook matcher 是可执行的正则字符串。
 *
 * @param context Platform validateBundle 生命周期上下文。
 * @param value matcher 候选值。
 * @param fieldPath matcher 在最终 Hook 配置中的字段路径。
 */
function validateHookMatcher(
  context: PlatformValidateContext,
  value: JsonValue,
  fieldPath: readonly (string | number)[],
): void {
  if (typeof value !== 'string') {
    report(context, 'CODEX_HOOK_MATCHER_INVALID', 'Hook matcher must be a regular-expression string.', fieldPath);
    return;
  }
  try {
    /** 构造正则只用于验证 Codex 将要解析的表达式语法。 */
    const expression = new RegExp(value);
    void expression;
  } catch {
    report(context, 'CODEX_HOOK_MATCHER_INVALID', 'Hook matcher must be a valid regular expression.', fieldPath);
  }
}

/**
 * 校验 Codex command Hook Handler 的字段和平台限制。
 *
 * @param context Platform validateBundle 生命周期上下文。
 * @param event 当前 Handler 所属事件。
 * @param value Handler 候选值。
 * @param fieldPath Handler 在最终 Hook 配置中的字段路径。
 */
function validateHookHandler(
  context: PlatformValidateContext,
  event: string,
  value: JsonValue,
  fieldPath: readonly (string | number)[],
): void {
  if (!isRecord(value)) {
    report(context, 'CODEX_HOOK_HANDLER_INVALID', 'Hook handlers must be JSON objects.', fieldPath);
    return;
  }
  if (value.type !== 'command') {
    report(context, 'CODEX_HOOK_HANDLER_TYPE_INVALID', 'Codex currently executes only command Hook handlers.', [...fieldPath, 'type']);
    return;
  }
  for (const field of Object.keys(value)) {
    if (!HOOK_HANDLER_FIELDS.has(field))
      report(context, 'CODEX_HOOK_HANDLER_FIELD_UNKNOWN', `Unknown Codex command Hook field "${field}".`, [...fieldPath, field]);
  }
  if (typeof value.command !== 'string' || value.command.trim().length === 0)
    report(context, 'CODEX_HOOK_COMMAND_INVALID', 'command Hook command must be a non-empty string.', [...fieldPath, 'command']);
  /** Windows 命令同时兼容 JSON camelCase 和 TOML snake_case 字段。 */
  for (const field of ['commandWindows', 'command_windows'] as const) {
    if (value[field] !== undefined && (typeof value[field] !== 'string' || value[field].trim().length === 0))
      report(context, 'CODEX_HOOK_WINDOWS_COMMAND_INVALID', `${field} must be a non-empty string.`, [...fieldPath, field]);
  }
  if (value.commandWindows !== undefined && value.command_windows !== undefined) {
    report(context, 'CODEX_HOOK_WINDOWS_COMMAND_DUPLICATE', 'Use only one Windows command field spelling.', fieldPath);
  }
  if (value.timeout !== undefined
    && (typeof value.timeout !== 'number' || !Number.isFinite(value.timeout) || value.timeout <= 0)) {
    report(context, 'CODEX_HOOK_TIMEOUT_INVALID', 'Hook timeout must be a positive finite number of seconds.', [...fieldPath, 'timeout']);
  } else if (event === 'SessionEnd' && typeof value.timeout === 'number' && value.timeout > 3) {
    report(context, 'CODEX_HOOK_TIMEOUT_LIMIT', 'SessionEnd Hook timeout must not exceed 3 seconds.', [...fieldPath, 'timeout']);
  }
  if (value.statusMessage !== undefined
    && (typeof value.statusMessage !== 'string' || value.statusMessage.trim().length === 0)) {
    report(context, 'CODEX_HOOK_STATUS_INVALID', 'Hook statusMessage must be a non-empty string.', [...fieldPath, 'statusMessage']);
  }
  if (value.additionalContextLimit !== undefined
    && (typeof value.additionalContextLimit !== 'number'
      || !Number.isInteger(value.additionalContextLimit)
      || value.additionalContextLimit < 0)) {
    report(context, 'CODEX_HOOK_CONTEXT_LIMIT_INVALID', 'additionalContextLimit must be a non-negative integer.', [...fieldPath, 'additionalContextLimit']);
  }
  if (value.async !== undefined && typeof value.async !== 'boolean')
    report(context, 'CODEX_HOOK_ASYNC_INVALID', 'command Hook async must be a boolean.', [...fieldPath, 'async']);
}

/**
 * 校验 Codex Hook 事件映射及其 matcher 分组。
 *
 * @param context Platform validateBundle 生命周期上下文。
 * @param value `hooks` 字段中的事件映射候选。
 * @param fieldPath 事件映射在最终配置中的字段路径。
 */
function validateHookEvents(
  context: PlatformValidateContext,
  value: JsonValue,
  fieldPath: readonly (string | number)[],
): void {
  if (!isRecord(value)) {
    report(context, 'CODEX_HOOK_EVENTS_INVALID', 'hooks must contain an event mapping.', fieldPath);
    return;
  }
  /** [event, groups] 表示当前遍历的 Codex 事件和 matcher 分组。 */
  for (const [event, groups] of Object.entries(value)) {
    /** 当前事件在最终配置中的稳定字段路径。 */
    const eventPath = [...fieldPath, event];
    if (!HOOK_EVENTS.has(event)) {
      report(context, 'CODEX_HOOK_EVENT_UNKNOWN', `Unknown Codex Hook event "${event}".`, eventPath);
      continue;
    }
    if (!Array.isArray(groups) || groups.length === 0) {
      report(context, 'CODEX_HOOK_GROUPS_INVALID', 'Each Hook event must contain one or more matcher groups.', eventPath);
      continue;
    }
    /** [groupIndex, groupValue] 表示当前事件中的 matcher 分组。 */
    for (const [groupIndex, groupValue] of groups.entries()) {
      /** 当前 matcher 分组的稳定字段路径。 */
      const groupPath = [...eventPath, groupIndex];
      if (!isRecord(groupValue)) {
        report(context, 'CODEX_HOOK_GROUP_INVALID', 'Hook matcher groups must be JSON objects.', groupPath);
        continue;
      }
      for (const field of Object.keys(groupValue)) {
        if (!HOOK_GROUP_FIELDS.has(field))
          report(context, 'CODEX_HOOK_GROUP_FIELD_UNKNOWN', `Unknown Codex Hook group field "${field}".`, [...groupPath, field]);
      }
      if (groupValue.matcher !== undefined)
        validateHookMatcher(context, groupValue.matcher, [...groupPath, 'matcher']);
      if (!Array.isArray(groupValue.hooks) || groupValue.hooks.length === 0) {
        report(context, 'CODEX_HOOK_HANDLERS_INVALID', 'Hook matcher groups must contain one or more handlers.', [...groupPath, 'hooks']);
        continue;
      }
      /** [handlerIndex, handler] 表示当前 matcher 分组中的 Handler。 */
      for (const [handlerIndex, handler] of groupValue.hooks.entries())
        validateHookHandler(context, event, handler, [...groupPath, 'hooks', handlerIndex]);
    }
  }
}

/**
 * 校验 Codex `hooks.json` 顶层结构或 Plugin Manifest 内联事件映射。
 *
 * @param context Platform validateBundle 生命周期上下文。
 * @param value 已解析的 Hook 配置对象。
 * @param fieldPath 配置在 Plugin Manifest 中的字段路径。
 * @param wrapped 是否要求配置使用 `hooks.json` 顶层包装。
 */
function validateHookConfig(
  context: PlatformValidateContext,
  value: JsonRecord,
  fieldPath: readonly (string | number)[],
  wrapped: boolean,
): void {
  if (!wrapped && value.hooks === undefined && value.description === undefined) {
    validateHookEvents(context, value, fieldPath);
    return;
  }
  for (const field of Object.keys(value)) {
    if (!HOOK_CONFIG_FIELDS.has(field))
      report(context, 'CODEX_HOOK_CONFIG_FIELD_UNKNOWN', `Unknown Codex Hook config field "${field}".`, [...fieldPath, field]);
  }
  if (value.description !== undefined
    && (typeof value.description !== 'string' || value.description.trim().length === 0)) {
    report(context, 'CODEX_HOOK_DESCRIPTION_INVALID', 'Hook config description must be a non-empty string.', [...fieldPath, 'description']);
  }
  if (value.hooks === undefined) {
    report(context, 'CODEX_HOOKS_REQUIRED', 'Hook config must contain a hooks event mapping.', [...fieldPath, 'hooks']);
    return;
  }
  validateHookEvents(context, value.hooks, [...fieldPath, 'hooks']);
}

/**
 * 读取并校验 Plugin 根内被引用的 Codex `hooks.json`。
 *
 * @param context Platform validateBundle 生命周期上下文。
 * @param pluginRoot Plugin 相对于候选 Distribution 根的安装目录。
 * @param reference 已通过安装根路径规则的 Hook 配置引用。
 * @param fieldPath 引用在 Plugin Manifest 中的字段路径。
 */
async function validateHookFile(
  context: PlatformValidateContext,
  pluginRoot: string,
  reference: string,
  fieldPath: readonly (string | number)[],
): Promise<void> {
  try {
    /** Hook 配置引用相对于当前 Plugin 根解析后的绝对候选路径。 */
    const hookPath = path.join(context.candidate.root, pluginRoot, reference.slice(2));
    /** JSON.parse 返回的未知配置值。 */
    const value: unknown = JSON.parse(await fs.readFile(hookPath, 'utf8'));
    if (!isRecord(value)) {
      report(context, 'CODEX_HOOK_CONFIG_OBJECT_REQUIRED', 'Hook config must contain a JSON object.', fieldPath);
      return;
    }
    validateHookConfig(context, value, fieldPath, true);
  } catch {
    report(context, 'CODEX_HOOK_CONFIG_READ_FAILED', 'Hook config reference must contain valid JSON.', fieldPath);
  }
}

/**
 * 校验 Hooks 字段允许的引用或内联配置，并验证最终配置内容。
 *
 * @param context Platform validateBundle 生命周期上下文。
 * @param artifacts 当前 DeliveryUnit 的 Artifact 路径集合。
 * @param pluginRoot Plugin 相对于候选 Distribution 根的安装目录。
 * @param value Hooks 字段候选。
 */
async function validateHooks(
  context: PlatformValidateContext,
  artifacts: ReadonlySet<string>,
  pluginRoot: string,
  value: JsonValue,
): Promise<void> {
  /** 校验并读取单个 Plugin 根路径引用。 */
  const validatePath = async (reference: string, fieldPath: readonly (string | number)[]): Promise<void> => {
    validateReference(context, artifacts, 'hooks', reference, fieldPath);
    if (isSafePluginReference(reference) && referenceExists(artifacts, reference))
      await validateHookFile(context, pluginRoot, reference, fieldPath);
  };
  if (typeof value === 'string') {
    await validatePath(value, ['hooks']);
    return;
  }
  if (isRecord(value)) {
    validateHookConfig(context, value, ['hooks'], false);
    return;
  }
  if (!Array.isArray(value) || value.length === 0) {
    report(context, 'CODEX_HOOKS_INVALID', 'hooks must be a path, paths, an inline object, or inline objects.', ['hooks']);
    return;
  }
  /** 全部为路径或全部为内联对象，避免依赖未声明的混合语义。 */
  const allPaths = value.every(item => typeof item === 'string');
  /** 内联 Hooks 数组是否全部为对象。 */
  const allObjects = value.every(isRecord);
  if (!allPaths && !allObjects) {
    report(context, 'CODEX_HOOKS_INVALID', 'hooks arrays must contain only paths or only inline objects.', ['hooks']);
    return;
  }
  if (allPaths) {
    for (const [index, reference] of value.entries())
      await validatePath(reference as string, ['hooks', index]);
    return;
  }
  for (const [index, inline] of value.entries())
    validateHookConfig(context, inline as JsonRecord, ['hooks', index], false);
}

/**
 * 校验 Skill 元数据中的相对资源引用。
 *
 * @param context Platform validateBundle 生命周期上下文。
 * @param artifacts 当前 DeliveryUnit 的 Artifact 路径集合。
 * @param pluginRoot Plugin 相对于候选 Distribution 根的安装目录。
 * @param skillId 当前 Skill 的最终目录 ID。
 * @param field 元数据资源字段名。
 * @param reference 相对于 Skill 根的资源路径。
 */
function validateSkillAssetReference(
  context: PlatformValidateContext,
  artifacts: ReadonlySet<string>,
  skillId: string,
  field: string,
  reference: string,
): void {
  /** Skill 资源遵循同一 `./` 安全规则，但解析基准是当前 Skill 根。 */
  if (!isSafePluginReference(reference)) {
    report(context, 'CODEX_SKILL_ASSET_UNSAFE', `${field} must start with ./ and stay inside the Skill root.`, ['skills', skillId, 'agents', 'openai.yaml', 'interface', field]);
    return;
  }
  /** Skill 相对引用转换后的完整 Artifact 路径。 */
  const artifactPath = `skills/${skillId}/${reference.slice(2)}`;
  if (!artifacts.has(artifactPath)) {
    report(context, 'CODEX_SKILL_ASSET_MISSING', `${field} references a missing Skill asset.`, ['skills', skillId, 'agents', 'openai.yaml', 'interface', field]);
  }
}

/**
 * 校验一个 Skill 的 `agents/openai.yaml` 官方结构。
 *
 * @param context Platform validateBundle 生命周期上下文。
 * @param artifacts 当前 DeliveryUnit 的 Artifact 路径集合。
 * @param skillId 当前 Skill 的最终目录 ID。
 */
async function validateSkillMetadata(
  context: PlatformValidateContext,
  artifacts: ReadonlySet<string>,
  pluginRoot: string,
  skillId: string,
): Promise<void> {
  /** 当前 Skill 元数据的固定 Artifact 路径。 */
  const metadataPath = `skills/${skillId}/agents/openai.yaml`;
  if (!artifacts.has(metadataPath))
    return;
  try {
    /** 从已物化候选读取 UTF-8 Skill 元数据。 */
    const source = await fs.readFile(path.join(context.candidate.root, pluginRoot, metadataPath), 'utf8');
    /** YAML 顶层必须为可验证的映射。 */
    const metadata = parseYamlObject(context, source, metadataPath);
    if (metadata === undefined)
      return;
    for (const field of Object.keys(metadata)) {
      if (!SKILL_METADATA_FIELDS.has(field))
        report(context, 'CODEX_SKILL_METADATA_FIELD_UNKNOWN', `Unknown ${metadataPath} field "${field}".`);
    }
    if (!isRecord(metadata.interface)) {
      report(context, 'CODEX_SKILL_INTERFACE_REQUIRED', `${metadataPath} must contain an interface mapping.`);
      return;
    }
    /** Skill interface 中已经通过对象校验的字段。 */
    const skillInterface = metadata.interface;
    for (const field of Object.keys(skillInterface)) {
      if (!SKILL_INTERFACE_FIELDS.has(field))
        report(context, 'CODEX_SKILL_INTERFACE_FIELD_UNKNOWN', `Unknown Skill interface field "${field}".`);
    }
    /** Skill 元数据存在时必须同时提供的两个展示字段。 */
    for (const field of ['display_name', 'short_description'] as const) {
      if (typeof skillInterface[field] !== 'string' || skillInterface[field].trim().length === 0)
        report(context, 'CODEX_SKILL_INTERFACE_FIELD_REQUIRED', `Skill interface.${field} must be a non-empty string.`);
    }
    for (const field of ['icon_small', 'icon_large'] as const) {
      /** 当前可选 Skill 图片引用。 */
      const candidate = skillInterface[field];
      if (candidate !== undefined) {
        if (typeof candidate !== 'string' || candidate.trim().length === 0)
          report(context, 'CODEX_SKILL_ASSET_INVALID', `Skill interface.${field} must be a non-empty path.`);
        else
          validateSkillAssetReference(context, artifacts, skillId, field, candidate);
      }
    }
    if (skillInterface.brand_color !== undefined
      && (typeof skillInterface.brand_color !== 'string' || !CODEX_BRAND_COLOR_PATTERN.test(skillInterface.brand_color))) {
      report(context, 'CODEX_SKILL_BRAND_COLOR_INVALID', 'Skill interface.brand_color must be a six-digit hexadecimal color.');
    }
    if (skillInterface.default_prompt !== undefined
      && (typeof skillInterface.default_prompt !== 'string' || skillInterface.default_prompt.trim().length === 0)) {
      report(context, 'CODEX_SKILL_DEFAULT_PROMPT_INVALID', 'Skill interface.default_prompt must be a non-empty string.');
    }
    if (metadata.policy !== undefined) {
      if (!isRecord(metadata.policy)) {
        report(context, 'CODEX_SKILL_POLICY_INVALID', 'Skill policy must be a YAML mapping.');
      } else {
        for (const field of Object.keys(metadata.policy)) {
          if (!SKILL_POLICY_FIELDS.has(field))
            report(context, 'CODEX_SKILL_POLICY_FIELD_UNKNOWN', `Unknown Skill policy field "${field}".`);
        }
        if (metadata.policy.allow_implicit_invocation !== undefined
          && typeof metadata.policy.allow_implicit_invocation !== 'boolean') {
          report(context, 'CODEX_SKILL_POLICY_INVALID', 'Skill policy.allow_implicit_invocation must be a boolean.');
        }
        if (metadata.policy.products !== undefined
          && (!Array.isArray(metadata.policy.products)
            || metadata.policy.products.length === 0
            || metadata.policy.products.some(product => typeof product !== 'string' || !SKILL_PRODUCTS.has(product))
            || new Set(metadata.policy.products).size !== metadata.policy.products.length)) {
          report(context, 'CODEX_SKILL_POLICY_INVALID', 'Skill policy.products must contain CHAT, CODEX, or both without duplicates.');
        }
      }
    }
    if (metadata.dependencies !== undefined) {
      if (!isRecord(metadata.dependencies)
        || Object.keys(metadata.dependencies).some(field => field !== 'tools')
        || !Array.isArray(metadata.dependencies.tools)) {
        report(context, 'CODEX_SKILL_DEPENDENCIES_INVALID', 'Skill dependencies may contain only a tools array.');
      }
    }
  } catch {
    report(context, 'CODEX_SKILL_METADATA_READ_FAILED', `${metadataPath} must be readable UTF-8 YAML.`);
  }
}

/**
 * 校验一个最终 Skill 的 Markdown、frontmatter、正文与可选元数据。
 *
 * @param context Platform validateBundle 生命周期上下文。
 * @param artifacts 当前 DeliveryUnit 的 Artifact 路径集合。
 * @param pluginRoot Plugin 相对于候选 Distribution 根的安装目录。
 * @param pluginName 当前 Plugin 的稳定机器名称。
 * @param skillId 当前 Skill 的最终目录 ID。
 * @param names 已验证 Skill frontmatter 名称的全局索引。
 */
async function validateSkill(
  context: PlatformValidateContext,
  artifacts: ReadonlySet<string>,
  pluginRoot: string,
  pluginName: string | undefined,
  skillId: string,
  names: Set<string>,
): Promise<void> {
  /** 当前 Skill Manifest 的固定 Artifact 路径。 */
  const manifestPath = `skills/${skillId}/SKILL.md`;
  if (!artifacts.has(manifestPath)) {
    report(context, 'CODEX_SKILL_MANIFEST_MISSING', `Skill directory "${skillId}" must contain SKILL.md.`, ['skills', skillId]);
    return;
  }
  try {
    /** 从已物化候选读取最终 Skill Markdown。 */
    const source = await fs.readFile(path.join(context.candidate.root, pluginRoot, manifestPath), 'utf8');
    /** Frontmatter 与正文使用固定边界，拒绝缺失或未闭合标记。 */
    const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/u.exec(source);
    if (match === null) {
      report(context, 'CODEX_SKILL_FRONTMATTER_INVALID', `${manifestPath} must start with closed YAML frontmatter.`);
      return;
    }
    /** 已从正则边界提取的 YAML frontmatter。 */
    const frontmatter = parseYamlObject(context, match[1]!, manifestPath);
    if (frontmatter === undefined)
      return;
    /** frontmatter 声明的 Skill 机器名称。 */
    const name = frontmatter.name;
    if (typeof name !== 'string' || !SKILL_ID_PATTERN.test(name)) {
      report(context, 'CODEX_SKILL_NAME_INVALID', `${manifestPath} name must use lowercase kebab-case.`);
    } else {
      /** Skill name 按平台最终选择器语义执行大小写不敏感唯一性。 */
      const key = name.toLocaleLowerCase('en-US');
      if (names.has(key))
        report(context, 'CODEX_SKILL_NAME_DUPLICATE', `Skill name "${name}" is duplicated.`);
      names.add(key);
      if (name !== skillId)
        report(context, 'CODEX_SKILL_NAME_MISMATCH', `${manifestPath} name must match its directory ID "${skillId}".`);
      if (pluginName !== undefined && `${pluginName}:${name}`.length > 64)
        report(context, 'CODEX_SKILL_IDENTITY_TOO_LONG', `Plugin and Skill identity "${pluginName}:${name}" exceeds 64 characters.`);
    }
    if (typeof frontmatter.description !== 'string'
      || frontmatter.description.trim().length === 0
      || frontmatter.description.length > 1_024) {
      report(context, 'CODEX_SKILL_DESCRIPTION_INVALID', `${manifestPath} description must contain 1 to 1024 characters.`);
    }
    if (match[2]!.trim().length === 0)
      report(context, 'CODEX_SKILL_BODY_EMPTY', `${manifestPath} instructions must not be empty.`);
    await validateSkillMetadata(context, artifacts, pluginRoot, skillId);
  } catch {
    report(context, 'CODEX_SKILL_READ_FAILED', `${manifestPath} must be readable UTF-8 Markdown.`);
  }
}

/**
 * 校验 `skills/` 根下每个直接子目录及其内容协议。
 *
 * @param context Platform validateBundle 生命周期上下文。
 * @param artifacts 当前 DeliveryUnit 的 Artifact 路径集合。
 * @param pluginRoot Plugin 相对于候选 Distribution 根的安装目录。
 * @param pluginName 当前 Plugin 的稳定机器名称。
 */
async function validateSkills(
  context: PlatformValidateContext,
  artifacts: ReadonlySet<string>,
  pluginRoot: string,
  pluginName: string | undefined,
): Promise<void> {
  /** 从任意 Skill Artifact 收集的直接子目录 ID。 */
  const directories = new Set<string>();
  for (const artifact of artifacts) {
    if (!artifact.startsWith('skills/'))
      continue;
    /** 当前 Skill Artifact 的 POSIX 路径片段。 */
    const segments = artifact.split('/');
    if (segments.length < 3 || segments[1] === '') {
      report(context, 'CODEX_SKILL_PATH_INVALID', `Invalid Skill Artifact path "${artifact}".`, ['skills']);
      continue;
    }
    directories.add(segments[1]!);
    if (artifact.endsWith('/SKILL.md') && segments.length !== 3)
      report(context, 'CODEX_SKILL_MANIFEST_NESTED', 'SKILL.md must be an immediate child of its Skill directory.', ['skills', segments[1]!]);
  }
  if (directories.size === 0) {
    report(context, 'CODEX_SKILL_REQUIRED', 'A Codex Plugin must contain at least one immediate child Skill.', ['skills']);
    return;
  }
  /** 已验证 Skill frontmatter 名称的全局唯一性集合。 */
  const names = new Set<string>();
  /** skillId 表示当前排序后的 Skill，用于生成确定诊断顺序。 */
  for (const skillId of [...directories].sort(compareCodeUnits)) {
    if (!SKILL_ID_PATTERN.test(skillId))
      report(context, 'CODEX_SKILL_DIRECTORY_INVALID', `Skill directory "${skillId}" must use lowercase kebab-case.`, ['skills', skillId]);
    await validateSkill(context, artifacts, pluginRoot, pluginName, skillId, names);
  }
}

/**
 * 校验 Plugin Manifest 字段、Skill 根和 Extension 引用。
 *
 * @param context Platform validateBundle 生命周期上下文。
 * @param manifest 已解析的 Codex Plugin Manifest。
 * @param pluginRoot Plugin 相对于候选 Distribution 根的安装目录。
 */
async function validatePluginManifest(
  context: PlatformValidateContext,
  manifest: JsonRecord,
  pluginRoot = '',
): Promise<void> {
  /** 当前 Plugin 安装根内的相对 Artifact 路径集合。 */
  const artifacts = scopedArtifacts(context, pluginRoot);
  for (const field of Object.keys(manifest)) {
    if (!PLUGIN_FIELDS.has(field))
      report(context, 'CODEX_MANIFEST_FIELD_UNKNOWN', `Unknown Codex Plugin field "${field}".`, [field]);
  }
  /** Codex Plugin Manifest 的三个稳定必填字符串字段。 */
  const required = ['name', 'version', 'description'] as const;
  for (const field of required) {
    if (typeof manifest[field] !== 'string' || manifest[field].trim().length === 0)
      report(context, 'CODEX_MANIFEST_FIELD_REQUIRED', `${field} must be a non-empty string.`, [field]);
  }
  if (typeof manifest.name === 'string'
    && (manifest.name.length > 64 || !PLUGIN_NAME_PATTERN.test(manifest.name))) {
    report(context, 'CODEX_MANIFEST_NAME_INVALID', 'name must use the official ASCII Plugin name format and contain at most 64 characters.', ['name']);
  }
  if (typeof manifest.version === 'string'
    && (manifest.version.length > 64 || !SEMVER_PATTERN.test(manifest.version))) {
    report(context, 'CODEX_MANIFEST_VERSION_INVALID', 'version must be a semantic version.', ['version']);
  }
  if (typeof manifest.description === 'string' && manifest.description.length > 1_024)
    report(context, 'CODEX_MANIFEST_DESCRIPTION_INVALID', 'description must contain at most 1024 characters.', ['description']);
  if (manifest.author !== undefined) {
    /** 通过对象检查后的作者字段。 */
    const author = isRecord(manifest.author) ? manifest.author : undefined;
    if (author === undefined || typeof author.name !== 'string' || author.name.trim().length === 0) {
      report(context, 'CODEX_MANIFEST_AUTHOR_INVALID', 'author.name must be a non-empty string.', ['author', 'name']);
    } else {
      for (const field of ['email', 'url'] as const) {
        if (author[field] !== undefined && (typeof author[field] !== 'string' || author[field].trim().length === 0))
          report(context, 'CODEX_MANIFEST_AUTHOR_INVALID', `author.${field} must be a non-empty string.`, ['author', field]);
      }
      if (typeof author.url === 'string' && (!isCodexHttpsUrl(author.url) || author.url.length > 2_048))
        report(context, 'CODEX_MANIFEST_AUTHOR_URL_INVALID', 'author.url must be an HTTPS URL without credentials.', ['author', 'url']);
    }
  }
  for (const field of ['homepage', 'repository', 'license'] as const) {
    if (manifest[field] !== undefined && (typeof manifest[field] !== 'string' || manifest[field].trim().length === 0))
      report(context, 'CODEX_MANIFEST_METADATA_INVALID', `${field} must be a non-empty string.`, [field]);
  }
  if (typeof manifest.homepage === 'string' && (!isCodexHttpsUrl(manifest.homepage) || manifest.homepage.length > 2_048))
    report(context, 'CODEX_MANIFEST_HOMEPAGE_INVALID', 'homepage must be an HTTPS URL without credentials.', ['homepage']);
  if (manifest.keywords !== undefined
    && (!Array.isArray(manifest.keywords)
      || manifest.keywords.some(keyword => typeof keyword !== 'string' || keyword.trim().length === 0)
      || new Set(manifest.keywords).size !== manifest.keywords.length)) {
    report(context, 'CODEX_MANIFEST_KEYWORDS_INVALID', 'keywords must contain unique non-empty strings.', ['keywords']);
  }
  if (manifest.skills !== './skills/')
    report(context, 'CODEX_SKILLS_PATH_INVALID', 'skills must point to the root ./skills/ directory.', ['skills']);
  await validateSkills(context, artifacts, pluginRoot, typeof manifest.name === 'string' ? manifest.name : undefined);
  if (manifest.interface !== undefined)
    await validateInterface(context, artifacts, pluginRoot, manifest.interface);
  if (manifest.mcpServers !== undefined) {
    if (typeof manifest.mcpServers !== 'string') {
      report(context, 'CODEX_MCP_REFERENCE_INVALID', 'mcpServers must be a Plugin-root file path.', ['mcpServers']);
    } else {
      validateReference(context, artifacts, 'mcpServers', manifest.mcpServers, ['mcpServers']);
    }
  }
  if (manifest.hooks !== undefined)
    await validateHooks(context, artifacts, pluginRoot, manifest.hooks);
  else if (artifacts.has('hooks/hooks.json'))
    await validateHookFile(context, pluginRoot, './hooks/hooks.json', ['hooks']);
}

/**
 * 校验 Marketplace 根清单和自包含 Plugin 来源。
 *
 * @param context Platform validateBundle 生命周期上下文。
 * @param marketplace 已解析的 Marketplace 清单。
 */
async function validateMarketplace(
  context: PlatformValidateContext,
  marketplace: JsonRecord,
): Promise<void> {
  for (const field of Object.keys(marketplace)) {
    if (!MARKETPLACE_FIELDS.has(field))
      report(context, 'CODEX_MARKETPLACE_FIELD_UNKNOWN', `Unknown Codex Marketplace field "${field}".`, [field]);
  }
  if (typeof marketplace.name !== 'string' || marketplace.name.trim().length === 0)
    report(context, 'CODEX_MARKETPLACE_NAME_REQUIRED', 'Marketplace name must be a non-empty string.', ['name']);
  if (!isRecord(marketplace.interface)
    || typeof marketplace.interface.displayName !== 'string'
    || marketplace.interface.displayName.trim().length === 0) {
    report(context, 'CODEX_MARKETPLACE_INTERFACE_REQUIRED', 'Marketplace interface.displayName must be present.', ['interface', 'displayName']);
  }
  if (!Array.isArray(marketplace.plugins)
    || marketplace.plugins.length === 0
    || marketplace.plugins.some(entry => !isRecord(entry))) {
    report(context, 'CODEX_MARKETPLACE_PLUGIN_REQUIRED', 'Marketplace must contain one or more Plugin entries.', ['plugins']);
    return;
  }
  /** 已验证来源用于阻止两个条目指向同一 Plugin 根。 */
  const sources = new Set<string>();
  /** 已验证名称用于阻止 Marketplace 内出现选择器歧义。 */
  const names = new Set<string>();
  /** [index, entryValue] 表示当前 Marketplace Plugin 条目。 */
  for (const [index, entryValue] of marketplace.plugins.entries()) {
    /** plugins 已经整体通过对象检查后的当前条目。 */
    const entry = entryValue as JsonRecord;
    for (const field of Object.keys(entry)) {
      if (!MARKETPLACE_PLUGIN_FIELDS.has(field))
        report(context, 'CODEX_MARKETPLACE_PLUGIN_FIELD_UNKNOWN', `Unknown Marketplace Plugin field "${field}".`, ['plugins', index, field]);
    }
    /** 已通过对象形态检查的本地来源候选。 */
    const source = isRecord(entry.source) ? entry.source : undefined;
    /** 当前来源中的本地路径候选。 */
    const sourcePath = source?.path;
    /** 单项保持兼容根布局，多项必须各自进入稳定 plugins 子目录。 */
    const sourceValid = source?.source === 'local'
      && typeof sourcePath === 'string'
      && (marketplace.plugins.length === 1 ? sourcePath === './' : MARKETPLACE_PLUGIN_SOURCE_PATTERN.test(sourcePath));
    if (!sourceValid) {
      report(context, 'CODEX_MARKETPLACE_SOURCE_INVALID', 'Single-Plugin source must be local "./"; multi-Plugin sources must use "./plugins/<unit-id>".', ['plugins', index, 'source']);
      continue;
    }
    if (sources.has(sourcePath))
      report(context, 'CODEX_MARKETPLACE_SOURCE_DUPLICATE', 'Marketplace Plugin sources must be unique.', ['plugins', index, 'source', 'path']);
    sources.add(sourcePath);
    /** `./` 对应 Distribution 根，其余来源去掉协议前缀后作为 Plugin 根。 */
    const pluginRoot = sourcePath === './' ? '' : sourcePath.slice(2);
    /** 当前来源根内必须存在且可解析的 Codex Plugin Manifest。 */
    const plugin = await readJson(context, pluginRoot === '' ? PLUGIN_MANIFEST_PATH : `${pluginRoot}/${PLUGIN_MANIFEST_PATH}`);
    if (plugin === undefined)
      continue;
    await validatePluginManifest(context, plugin, pluginRoot);
    if (entry.name !== plugin.name)
      report(context, 'CODEX_MARKETPLACE_PLUGIN_MISMATCH', 'Marketplace Plugin name must match its bundled Plugin Manifest.', ['plugins', index, 'name']);
    if (typeof entry.name === 'string') {
      /** Marketplace 名称使用 Plugin Manifest 的稳定选择器值。 */
      const name = entry.name;
      if (names.has(name))
        report(context, 'CODEX_MARKETPLACE_PLUGIN_DUPLICATE', 'Marketplace Plugin names must be unique.', ['plugins', index, 'name']);
      names.add(name);
    }
    if (!isRecord(entry.policy)
      || typeof entry.policy.installation !== 'string'
      || !INSTALLATION_POLICIES.has(entry.policy.installation)
      || entry.policy.authentication !== 'ON_INSTALL') {
      report(context, 'CODEX_MARKETPLACE_POLICY_INVALID', 'Marketplace policy must include a supported installation value and ON_INSTALL authentication.', ['plugins', index, 'policy']);
    }
    if (typeof entry.category !== 'string' || !CATEGORIES.has(entry.category))
      report(context, 'CODEX_MARKETPLACE_CATEGORY_INVALID', 'Marketplace category must be an official Plugin category.', ['plugins', index, 'category']);
  }
}

/**
 * 校验主 Plugin 或 Marketplace Distribution 的最终安装根契约。
 *
 * @param context Core 提供的已安全物化候选。
 */
export async function validateCodexBundle(context: PlatformValidateContext): Promise<void> {
  if (context.candidate.unit.type === 'marketplace') {
    /** Distribution 额外要求 Repo Marketplace 固定路径。 */
    const marketplace = await readJson(context, MARKETPLACE_MANIFEST_PATH);
    if (marketplace !== undefined)
      await validateMarketplace(context, marketplace);
    return;
  }
  /** 主单元始终使用安装根固定 Plugin Manifest。 */
  const plugin = await readJson(context, PLUGIN_MANIFEST_PATH);
  if (plugin !== undefined)
    await validatePluginManifest(context, plugin);
  if (context.candidate.unit.artifacts.some(artifact => artifact.path === MARKETPLACE_MANIFEST_PATH)) {
    report(context, 'CODEX_MARKETPLACE_IN_PRIMARY', 'Primary Plugin must not contain a Marketplace manifest.');
  }
}
