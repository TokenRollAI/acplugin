import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { JsonValue, PlatformValidateContext } from '@tokenroll/acplugin';
import { MARKETPLACE_MANIFEST_PATH, PLUGIN_MANIFEST_PATH } from './manifest.js';

/** Claude Code Plugin 清单允许出现的官方根字段。 */
const PLUGIN_FIELDS = new Set([
  '$schema', 'name', 'version', 'description', 'displayName', 'author', 'homepage', 'repository', 'license',
  'keywords', 'metadata', 'defaultEnabled', 'commands', 'agents', 'skills', 'hooks', 'mcpServers', 'lspServers',
  'outputStyles', 'experimental', 'dependencies',
]);

/** 由当前 Platform 生成并需要执行安装根引用验证的 Component 字段。 */
const COMPONENT_REFERENCE_FIELDS = ['commands', 'skills', 'agents'] as const;

/** 允许按路径或内联对象表达的 Extension 字段。 */
const EXTENSION_REFERENCE_FIELDS = ['hooks', 'mcpServers'] as const;

/** Claude Code Plugin 名称允许使用的小写 kebab-case 规则。 */
const PLUGIN_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Claude Code 当前公开的全部 Hook 事件，包括可移植事件和平台专属事件。 */
const HOOK_EVENTS = new Set([
  'SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PreToolUse', 'PermissionRequest', 'PostToolUse',
  'PreCompact', 'PostCompact', 'SubagentStart', 'SubagentStop', 'Stop', 'Setup', 'UserPromptExpansion',
  'PermissionDenied', 'PostToolUseFailure', 'PostToolBatch', 'Notification', 'MessageDisplay', 'TaskCreated',
  'TaskCompleted', 'StopFailure', 'TeammateIdle', 'InstructionsLoaded', 'ConfigChange', 'CwdChanged',
  'DirectoryAdded', 'FileChanged', 'WorktreeCreate', 'WorktreeRemove', 'Elicitation', 'ElicitationResult',
]);

/** Claude Code Hook 配置文件顶层允许出现的字段。 */
const HOOK_CONFIG_FIELDS = new Set(['description', 'hooks']);

/** 单个 Claude Code Hook matcher 分组允许出现的字段。 */
const HOOK_GROUP_FIELDS = new Set(['matcher', 'hooks']);

/** Claude Code 当前公开的 Handler 类型。 */
const HOOK_HANDLER_TYPES = new Set(['command', 'prompt', 'agent', 'http', 'mcp_tool']);

/** Claude Code 明确允许五类 Handler 的事件。 */
const HOOK_EVENTS_WITH_ALL_HANDLER_TYPES = new Set([
  'PermissionDenied', 'PermissionRequest', 'PostToolBatch', 'PostToolUse', 'PostToolUseFailure',
  'PreToolUse', 'Stop', 'SubagentStop', 'TaskCompleted', 'TaskCreated', 'TeammateIdle',
  'UserPromptExpansion', 'UserPromptSubmit',
]);

/** Claude Code 允许 command/http/mcp_tool、但不允许 prompt/agent 的事件。 */
const HOOK_EVENTS_WITH_COMMAND_HTTP_MCP_TYPES = new Set([
  'ConfigChange', 'CwdChanged', 'DirectoryAdded', 'Elicitation', 'ElicitationResult', 'FileChanged',
  'InstructionsLoaded', 'Notification', 'PostCompact', 'PreCompact', 'SessionEnd', 'StopFailure',
  'SubagentStart', 'WorktreeCreate', 'WorktreeRemove',
]);

/** Claude Code 只允许 command 和 mcp_tool 的启动类事件。 */
const HOOK_EVENTS_WITH_COMMAND_MCP_TYPES = new Set(['SessionStart', 'Setup']);

/** 非 prompt/agent 事件共同使用的三类 Handler。 */
const HOOK_HANDLER_COMMAND_HTTP_MCP_TYPES = new Set(['command', 'http', 'mcp_tool']);

/** 启动类事件共同使用的两类 Handler。 */
const HOOK_HANDLER_COMMAND_MCP_TYPES = new Set(['command', 'mcp_tool']);

/** 未出现在官方类型矩阵中的事件使用最保守 command 契约。 */
const HOOK_HANDLER_COMMAND_ONLY = new Set(['command']);

/** 所有 Claude Code Handler 类型共同允许出现的执行字段。 */
const HOOK_HANDLER_COMMON_FIELDS = ['type', 'if', 'timeout', 'statusMessage', 'once'] as const;

/** 不同 Claude Code Handler 类型允许出现的字段。 */
const HOOK_HANDLER_FIELDS: Readonly<Record<string, ReadonlySet<string>>> = Object.freeze({
  command: new Set([...HOOK_HANDLER_COMMON_FIELDS, 'command', 'args', 'async', 'asyncRewake', 'shell']),
  prompt: new Set([...HOOK_HANDLER_COMMON_FIELDS, 'prompt', 'model']),
  agent: new Set([...HOOK_HANDLER_COMMON_FIELDS, 'prompt', 'model']),
  http: new Set([...HOOK_HANDLER_COMMON_FIELDS, 'url', 'headers', 'allowedEnvVars']),
  mcp_tool: new Set([...HOOK_HANDLER_COMMON_FIELDS, 'server', 'tool', 'input']),
});

/** 多 Plugin Marketplace 的本地来源必须使用稳定单元目录。 */
const MARKETPLACE_PLUGIN_SOURCE_PATTERN = /^\.\/plugins\/[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Claude Code Marketplace 根清单允许出现的官方字段。 */
const MARKETPLACE_FIELDS = new Set(['name', 'owner', 'description', 'version', 'metadata', 'plugins']);

/** Claude Code Marketplace 每个 Plugin 条目允许出现的官方字段。 */
const MARKETPLACE_PLUGIN_FIELDS = new Set([
  'name', 'source', 'description', 'version', 'author', 'homepage', 'repository', 'license', 'keywords',
  'category', 'tags', 'strict',
]);

/** JSON 对象的运行时只读索引类型。 */
type JsonRecord = Record<string, JsonValue>;

/**
 * 判断未知值是否为非数组 JSON 对象。
 *
 * @param value 从候选清单解析的未知 JSON 值。
 * @returns 可以按字段读取时返回 true。
 */
function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * 向 Core 提交 Claude Code 候选校验错误。
 *
 * @param context Platform validateBundle 生命周期上下文。
 * @param code 稳定诊断码。
 * @param message 不包含宿主绝对路径的错误信息。
 * @param fieldPath 可选的清单字段路径。
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
    /** 从已由 Core 安全物化的候选根读取清单文本。 */
    const source = await fs.readFile(path.join(context.candidate.root, artifactPath), 'utf8');
    /** JSON.parse 返回的未知值必须继续验证顶层对象形态。 */
    const value: unknown = JSON.parse(source);
    if (!isRecord(value)) {
      report(context, 'CLAUDE_MANIFEST_OBJECT_REQUIRED', `${artifactPath} must contain a JSON object.`);
      return undefined;
    }
    return value;
  } catch {
    report(context, 'CLAUDE_MANIFEST_READ_FAILED', `${artifactPath} must be present and contain valid JSON.`);
    return undefined;
  }
}

/**
 * 判断清单路径引用是否严格位于当前 Plugin 安装根。
 *
 * @param reference Claude Code 清单中的相对路径。
 * @returns 使用 `./`、不逃逸且不指向根本身时返回 true。
 */
function isSafePluginReference(reference: string): boolean {
  if (!reference.startsWith('./') || reference.includes('\\') || reference.includes('\0'))
    return false;
  /** 去除协议要求的 `./` 后执行 POSIX 规范化。 */
  const relative = reference.slice(2);
  /** 规范化后的路径用于拒绝空路径、绝对路径和父目录逃逸。 */
  const normalized = path.posix.normalize(relative);
  return relative.length > 0
    && normalized !== '.'
    && normalized !== '..'
    && !normalized.startsWith('../')
    && !path.posix.isAbsolute(normalized);
}

/**
 * 判断候选 Artifact 集合是否满足文件或目录引用。
 *
 * @param artifacts 当前 DeliveryUnit 的全部规范 Artifact 路径。
 * @param reference 已通过安全规则校验的 Claude Code 路径引用。
 * @returns 精确文件或目录前缀至少匹配一个 Artifact 时返回 true。
 */
function referenceExists(artifacts: ReadonlySet<string>, reference: string): boolean {
  /** 清单引用去除固定 `./` 后的 Artifact 路径。 */
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
 * 校验 Claude Code Hook matcher 是可执行的正则字符串。
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
    report(context, 'CLAUDE_HOOK_MATCHER_INVALID', 'Hook matcher must be a regular-expression string.', fieldPath);
    return;
  }
  try {
    /** 构造正则只用于验证平台将要解析的表达式语法。 */
    const expression = new RegExp(value);
    void expression;
  } catch {
    report(context, 'CLAUDE_HOOK_MATCHER_INVALID', 'Hook matcher must be a valid regular expression.', fieldPath);
  }
}

/**
 * 校验 Claude Code Hook Handler 的类型、必填字段和公共执行选项。
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
    report(context, 'CLAUDE_HOOK_HANDLER_INVALID', 'Hook handlers must be JSON objects.', fieldPath);
    return;
  }
  /** 已完成对象检查的 Handler 类型候选。 */
  const type = value.type;
  if (typeof type !== 'string' || !HOOK_HANDLER_TYPES.has(type)) {
    report(context, 'CLAUDE_HOOK_HANDLER_TYPE_INVALID', 'Hook handler type is not supported by Claude Code.', [...fieldPath, 'type']);
    return;
  }
  /** 当前事件由官方矩阵允许的 Handler 类型集合；其余事件只接受 command。 */
  const allowedTypes = HOOK_EVENTS_WITH_ALL_HANDLER_TYPES.has(event)
    ? HOOK_HANDLER_TYPES
    : HOOK_EVENTS_WITH_COMMAND_HTTP_MCP_TYPES.has(event)
      ? HOOK_HANDLER_COMMAND_HTTP_MCP_TYPES
      : HOOK_EVENTS_WITH_COMMAND_MCP_TYPES.has(event)
        ? HOOK_HANDLER_COMMAND_MCP_TYPES
        : HOOK_HANDLER_COMMAND_ONLY;
  if (!allowedTypes.has(type)) {
    report(
      context,
      'CLAUDE_HOOK_HANDLER_EVENT_UNSUPPORTED',
      `${type} Hook handlers are not supported for Claude Code event "${event}".`,
      [...fieldPath, 'type'],
    );
  }
  /** 当前 Handler 类型对应的官方字段集合。 */
  const fields = HOOK_HANDLER_FIELDS[type]!;
  for (const field of Object.keys(value)) {
    if (!fields.has(field))
      report(context, 'CLAUDE_HOOK_HANDLER_FIELD_UNKNOWN', `Unknown Claude Code ${type} Hook field "${field}".`, [...fieldPath, field]);
  }
  /** 当前 Handler 类型要求提供的全部非空字符串目标字段。 */
  const requiredFields = type === 'command'
    ? ['command']
    : type === 'http'
      ? ['url']
      : type === 'mcp_tool'
        ? ['server', 'tool']
        : ['prompt'];
  /** requiredField 表示当前类型的一个必填目标字段。 */
  for (const requiredField of requiredFields) {
    if (typeof value[requiredField] !== 'string' || value[requiredField].trim().length === 0) {
      report(context, 'CLAUDE_HOOK_HANDLER_TARGET_INVALID', `${type} Hook ${requiredField} must be a non-empty string.`, [...fieldPath, requiredField]);
    }
  }
  if (value.args !== undefined
    && (!Array.isArray(value.args) || value.args.some(argument => typeof argument !== 'string'))) {
    report(context, 'CLAUDE_HOOK_HANDLER_ARGS_INVALID', 'command Hook args must contain only strings.', [...fieldPath, 'args']);
  }
  if (value.timeout !== undefined
    && (typeof value.timeout !== 'number' || !Number.isFinite(value.timeout) || value.timeout <= 0)) {
    report(context, 'CLAUDE_HOOK_TIMEOUT_INVALID', 'Hook timeout must be a positive finite number of seconds.', [...fieldPath, 'timeout']);
  } else if (event === 'SessionEnd' && typeof value.timeout === 'number' && value.timeout > 60) {
    report(context, 'CLAUDE_HOOK_TIMEOUT_LIMIT', 'SessionEnd Hook timeout must not exceed 60 seconds.', [...fieldPath, 'timeout']);
  }
  if (value.statusMessage !== undefined
    && (typeof value.statusMessage !== 'string' || value.statusMessage.trim().length === 0)) {
    report(context, 'CLAUDE_HOOK_STATUS_INVALID', 'Hook statusMessage must be a non-empty string.', [...fieldPath, 'statusMessage']);
  }
  if (value.if !== undefined && (typeof value.if !== 'string' || value.if.trim().length === 0))
    report(context, 'CLAUDE_HOOK_IF_INVALID', 'Hook if must be a non-empty permission rule.', [...fieldPath, 'if']);
  if (value.async !== undefined && typeof value.async !== 'boolean')
    report(context, 'CLAUDE_HOOK_ASYNC_INVALID', 'command Hook async must be a boolean.', [...fieldPath, 'async']);
  if (value.asyncRewake !== undefined && typeof value.asyncRewake !== 'boolean')
    report(context, 'CLAUDE_HOOK_ASYNC_REWAKE_INVALID', 'command Hook asyncRewake must be a boolean.', [...fieldPath, 'asyncRewake']);
  if (value.once !== undefined && typeof value.once !== 'boolean')
    report(context, 'CLAUDE_HOOK_ONCE_INVALID', 'Hook once must be a boolean.', [...fieldPath, 'once']);
  if (value.shell !== undefined && value.shell !== 'bash' && value.shell !== 'powershell')
    report(context, 'CLAUDE_HOOK_SHELL_INVALID', 'command Hook shell must be bash or powershell.', [...fieldPath, 'shell']);
  if (value.model !== undefined && (typeof value.model !== 'string' || value.model.trim().length === 0))
    report(context, 'CLAUDE_HOOK_MODEL_INVALID', 'prompt or agent Hook model must be a non-empty string.', [...fieldPath, 'model']);
  if (value.url !== undefined && typeof value.url === 'string') {
    try {
      /** HTTP Hook 地址允许官方支持的 HTTP(S)，但拒绝内联凭据。 */
      const url = new URL(value.url);
      if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username !== '' || url.password !== '')
        throw new TypeError('Unsafe HTTP Hook URL.');
    } catch {
      report(context, 'CLAUDE_HOOK_URL_INVALID', 'HTTP Hook url must be an HTTP(S) URL without credentials.', [...fieldPath, 'url']);
    }
  }
  if (value.headers !== undefined
    && (!isRecord(value.headers) || Object.values(value.headers).some(header => typeof header !== 'string'))) {
    report(context, 'CLAUDE_HOOK_HEADERS_INVALID', 'HTTP Hook headers must map names to string values.', [...fieldPath, 'headers']);
  }
  if (value.allowedEnvVars !== undefined
    && (!Array.isArray(value.allowedEnvVars)
      || value.allowedEnvVars.some(variable => typeof variable !== 'string' || variable.trim().length === 0))) {
    report(context, 'CLAUDE_HOOK_ENV_INVALID', 'HTTP Hook allowedEnvVars must contain non-empty strings.', [...fieldPath, 'allowedEnvVars']);
  }
  if (value.input !== undefined && !isRecord(value.input))
    report(context, 'CLAUDE_HOOK_MCP_INPUT_INVALID', 'mcp_tool Hook input must be a JSON object.', [...fieldPath, 'input']);
}

/**
 * 校验 Claude Code Hook 事件映射及其 matcher 分组。
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
    report(context, 'CLAUDE_HOOK_EVENTS_INVALID', 'hooks must contain an event mapping.', fieldPath);
    return;
  }
  /** [event, groups] 表示当前遍历的原生事件和 matcher 分组。 */
  for (const [event, groups] of Object.entries(value)) {
    /** 当前事件在最终配置中的稳定字段路径。 */
    const eventPath = [...fieldPath, event];
    if (!HOOK_EVENTS.has(event)) {
      report(context, 'CLAUDE_HOOK_EVENT_UNKNOWN', `Unknown Claude Code Hook event "${event}".`, eventPath);
      continue;
    }
    if (!Array.isArray(groups) || groups.length === 0) {
      report(context, 'CLAUDE_HOOK_GROUPS_INVALID', 'Each Hook event must contain one or more matcher groups.', eventPath);
      continue;
    }
    /** [groupIndex, groupValue] 表示当前事件中的 matcher 分组。 */
    for (const [groupIndex, groupValue] of groups.entries()) {
      /** 当前 matcher 分组的稳定字段路径。 */
      const groupPath = [...eventPath, groupIndex];
      if (!isRecord(groupValue)) {
        report(context, 'CLAUDE_HOOK_GROUP_INVALID', 'Hook matcher groups must be JSON objects.', groupPath);
        continue;
      }
      for (const field of Object.keys(groupValue)) {
        if (!HOOK_GROUP_FIELDS.has(field))
          report(context, 'CLAUDE_HOOK_GROUP_FIELD_UNKNOWN', `Unknown Claude Code Hook group field "${field}".`, [...groupPath, field]);
      }
      if (groupValue.matcher !== undefined)
        validateHookMatcher(context, groupValue.matcher, [...groupPath, 'matcher']);
      if (!Array.isArray(groupValue.hooks) || groupValue.hooks.length === 0) {
        report(context, 'CLAUDE_HOOK_HANDLERS_INVALID', 'Hook matcher groups must contain one or more handlers.', [...groupPath, 'hooks']);
        continue;
      }
      /** [handlerIndex, handler] 表示当前 matcher 分组中的 Handler。 */
      for (const [handlerIndex, handler] of groupValue.hooks.entries())
        validateHookHandler(context, event, handler, [...groupPath, 'hooks', handlerIndex]);
    }
  }
}

/**
 * 校验 Claude Code `hooks.json` 顶层结构。
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
      report(context, 'CLAUDE_HOOK_CONFIG_FIELD_UNKNOWN', `Unknown Claude Code Hook config field "${field}".`, [...fieldPath, field]);
  }
  if (value.description !== undefined
    && (typeof value.description !== 'string' || value.description.trim().length === 0)) {
    report(context, 'CLAUDE_HOOK_DESCRIPTION_INVALID', 'Hook config description must be a non-empty string.', [...fieldPath, 'description']);
  }
  if (value.hooks === undefined) {
    report(context, 'CLAUDE_HOOKS_REQUIRED', 'Hook config must contain a hooks event mapping.', [...fieldPath, 'hooks']);
    return;
  }
  validateHookEvents(context, value.hooks, [...fieldPath, 'hooks']);
}

/**
 * 读取并校验 Plugin 根内被引用的 Claude Code `hooks.json`。
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
      report(context, 'CLAUDE_HOOK_CONFIG_OBJECT_REQUIRED', 'Hook config must contain a JSON object.', fieldPath);
      return;
    }
    validateHookConfig(context, value, fieldPath, true);
  } catch {
    report(context, 'CLAUDE_HOOK_CONFIG_READ_FAILED', 'Hook config reference must contain valid JSON.', fieldPath);
  }
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
 * 校验一个清单引用值的类型、安全性和安装根内存在性。
 *
 * @param context Platform validateBundle 生命周期上下文。
 * @param artifacts 当前 DeliveryUnit 的 Artifact 路径集合。
 * @param field 当前引用所属的清单字段。
 * @param value 单路径或路径数组候选。
 */
function validateReferences(
  context: PlatformValidateContext,
  artifacts: ReadonlySet<string>,
  field: string,
  value: JsonValue,
): void {
  /** 统一转换后的引用列表，保持清单声明顺序。 */
  const references = typeof value === 'string'
    ? [value]
    : Array.isArray(value) && value.every(item => typeof item === 'string')
      ? value as readonly string[]
      : undefined;
  if (references === undefined || references.length === 0) {
    report(context, 'CLAUDE_MANIFEST_REFERENCE_INVALID', `${field} must be a path or non-empty path array.`, [field]);
    return;
  }
  for (const [index, reference] of references.entries()) {
    /** 当前引用在单值或数组字段中的诊断位置。 */
    const fieldPath: readonly (string | number)[] = references.length === 1 ? [field] : [field, index];
    if (!isSafePluginReference(reference)) {
      report(context, 'CLAUDE_MANIFEST_REFERENCE_UNSAFE', `${field} references must start with ./ and stay inside the Plugin root.`, fieldPath);
    } else if (!referenceExists(artifacts, reference)) {
      report(context, 'CLAUDE_MANIFEST_REFERENCE_MISSING', `${field} references a missing Plugin file or directory.`, fieldPath);
    }
  }
}

/**
 * 校验 Claude Code Plugin 清单字段、Component 目录和 Extension 引用。
 *
 * @param context Platform validateBundle 生命周期上下文。
 * @param manifest 已解析的 Plugin 清单对象。
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
      report(context, 'CLAUDE_MANIFEST_FIELD_UNKNOWN', `Unknown Claude Code Plugin field "${field}".`, [field]);
  }
  /** 必填字符串字段及其期望的非空值。 */
  const required = ['name', 'version', 'description'] as const;
  for (const field of required) {
    if (typeof manifest[field] !== 'string' || manifest[field].trim().length === 0)
      report(context, 'CLAUDE_MANIFEST_FIELD_REQUIRED', `${field} must be a non-empty string.`, [field]);
  }
  if (typeof manifest.name === 'string' && !PLUGIN_NAME_PATTERN.test(manifest.name))
    report(context, 'CLAUDE_MANIFEST_NAME_INVALID', 'name must use lowercase kebab-case.', ['name']);
  /** 可选字符串元数据必须保持非空字符串形态。 */
  const optionalStrings = ['displayName', 'homepage', 'repository', 'license'] as const;
  for (const field of optionalStrings) {
    if (manifest[field] !== undefined && (typeof manifest[field] !== 'string' || manifest[field].trim().length === 0))
      report(context, 'CLAUDE_MANIFEST_METADATA_INVALID', `${field} must be a non-empty string.`, [field]);
  }
  if (manifest.author !== undefined) {
    /** Plugin 清单中经过对象形态检查的作者字段。 */
    const author = isRecord(manifest.author) ? manifest.author : undefined;
    if (author === undefined || typeof author.name !== 'string' || author.name.trim().length === 0) {
      report(context, 'CLAUDE_MANIFEST_AUTHOR_INVALID', 'author.name must be a non-empty string.', ['author', 'name']);
    } else {
      /** author 的可选联系字段只能是非空字符串。 */
      const authorFields = ['email', 'url'] as const;
      for (const field of authorFields) {
        if (author[field] !== undefined && (typeof author[field] !== 'string' || author[field].trim().length === 0))
          report(context, 'CLAUDE_MANIFEST_AUTHOR_INVALID', `author.${field} must be a non-empty string.`, ['author', field]);
      }
    }
  }
  if (manifest.keywords !== undefined
    && (!Array.isArray(manifest.keywords)
      || manifest.keywords.some(keyword => typeof keyword !== 'string' || keyword.trim().length === 0)
      || new Set(manifest.keywords).size !== manifest.keywords.length)) {
    report(context, 'CLAUDE_MANIFEST_KEYWORDS_INVALID', 'keywords must contain unique non-empty strings.', ['keywords']);
  }
  if (manifest.defaultEnabled !== undefined && typeof manifest.defaultEnabled !== 'boolean')
    report(context, 'CLAUDE_MANIFEST_DEFAULT_INVALID', 'defaultEnabled must be a boolean.', ['defaultEnabled']);
  for (const field of COMPONENT_REFERENCE_FIELDS) {
    if (manifest[field] !== undefined)
      validateReferences(context, artifacts, field, manifest[field]);
  }
  for (const field of EXTENSION_REFERENCE_FIELDS) {
    /** 当前 Extension 添加的清单字段值。 */
    const value = manifest[field];
    if (value === undefined)
      continue;
    if (typeof value === 'string') {
      validateReferences(context, artifacts, field, value);
      if (field === 'hooks' && isSafePluginReference(value) && referenceExists(artifacts, value))
        await validateHookFile(context, pluginRoot, value, [field]);
    } else if (!isRecord(value)) {
      report(context, 'CLAUDE_EXTENSION_FIELD_INVALID', `${field} must be a Plugin path or inline object.`, [field]);
    } else if (field === 'hooks') {
      validateHookConfig(context, value, [field], false);
    }
  }
  if (manifest.hooks === undefined && artifacts.has('hooks/hooks.json'))
    await validateHookFile(context, pluginRoot, './hooks/hooks.json', ['hooks']);
}

/**
 * 校验 Marketplace 根清单与自包含 Plugin 的身份和引用。
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
      report(context, 'CLAUDE_MARKETPLACE_FIELD_UNKNOWN', `Unknown Claude Code Marketplace field "${field}".`, [field]);
  }
  if (typeof marketplace.name !== 'string' || marketplace.name.trim().length === 0)
    report(context, 'CLAUDE_MARKETPLACE_NAME_REQUIRED', 'Marketplace name must be a non-empty string.', ['name']);
  if (!isRecord(marketplace.owner) || typeof marketplace.owner.name !== 'string' || marketplace.owner.name.trim().length === 0) {
    report(context, 'CLAUDE_MARKETPLACE_OWNER_REQUIRED', 'Marketplace owner.name must be present.', ['owner', 'name']);
  } else {
    /** Marketplace owner 可选联系方式字段。 */
    const ownerFields = ['email', 'url'] as const;
    for (const field of ownerFields) {
      if (marketplace.owner[field] !== undefined
        && (typeof marketplace.owner[field] !== 'string' || marketplace.owner[field].trim().length === 0)) {
        report(context, 'CLAUDE_MARKETPLACE_OWNER_INVALID', `Marketplace owner.${field} must be a non-empty string.`, ['owner', field]);
      }
    }
  }
  if (typeof marketplace.description !== 'string' || marketplace.description.trim().length === 0)
    report(context, 'CLAUDE_MARKETPLACE_DESCRIPTION_REQUIRED', 'Marketplace description must be a non-empty string.', ['description']);
  if (typeof marketplace.version !== 'string' || marketplace.version.trim().length === 0)
    report(context, 'CLAUDE_MARKETPLACE_VERSION_REQUIRED', 'Marketplace version must be a non-empty string.', ['version']);
  if (!isRecord(marketplace.metadata) || marketplace.metadata.pluginRoot !== './')
    report(context, 'CLAUDE_MARKETPLACE_ROOT_INVALID', 'Marketplace metadata.pluginRoot must be "./".', ['metadata', 'pluginRoot']);
  if (!Array.isArray(marketplace.plugins)
    || marketplace.plugins.length === 0
    || marketplace.plugins.some(entry => !isRecord(entry))) {
    report(context, 'CLAUDE_MARKETPLACE_PLUGIN_REQUIRED', 'Marketplace must contain one or more Plugin entries.', ['plugins']);
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
        report(context, 'CLAUDE_MARKETPLACE_PLUGIN_FIELD_UNKNOWN', `Unknown Marketplace Plugin field "${field}".`, ['plugins', index, field]);
    }
    /** 当前条目声明的本地 Plugin 来源。 */
    const source = entry.source;
    /** 单项保持兼容根布局，多项必须各自进入稳定 plugins 子目录。 */
    const sourceValid = typeof source === 'string'
      && (marketplace.plugins.length === 1 ? source === './' : MARKETPLACE_PLUGIN_SOURCE_PATTERN.test(source));
    if (!sourceValid) {
      report(context, 'CLAUDE_MARKETPLACE_SOURCE_INVALID', 'Single-Plugin source must be "./"; multi-Plugin sources must use "./plugins/<unit-id>".', ['plugins', index, 'source']);
      continue;
    }
    if (sources.has(source))
      report(context, 'CLAUDE_MARKETPLACE_SOURCE_DUPLICATE', 'Marketplace Plugin sources must be unique.', ['plugins', index, 'source']);
    sources.add(source);
    /** `./` 对应 Distribution 根，其余来源去掉协议前缀后作为 Plugin 根。 */
    const pluginRoot = source === './' ? '' : source.slice(2);
    /** 当前来源根内必须存在且可解析的 Claude Code Plugin Manifest。 */
    const plugin = await readJson(context, pluginRoot === '' ? PLUGIN_MANIFEST_PATH : `${pluginRoot}/${PLUGIN_MANIFEST_PATH}`);
    if (plugin === undefined)
      continue;
    await validatePluginManifest(context, plugin, pluginRoot);
    if (entry.name !== plugin.name || entry.version !== plugin.version || entry.description !== plugin.description) {
      report(context, 'CLAUDE_MARKETPLACE_PLUGIN_MISMATCH', 'Marketplace Plugin metadata must match its bundled Plugin manifest.', ['plugins', index]);
    }
    if (typeof entry.name === 'string') {
      /** Marketplace 名称使用平台选择器的大小写敏感规范值。 */
      const name = entry.name;
      if (names.has(name))
        report(context, 'CLAUDE_MARKETPLACE_PLUGIN_DUPLICATE', 'Marketplace Plugin names must be unique.', ['plugins', index, 'name']);
      names.add(name);
    }
    if (entry.strict !== true)
      report(context, 'CLAUDE_MARKETPLACE_STRICT_REQUIRED', 'Self-contained Marketplace Plugins must use strict: true.', ['plugins', index, 'strict']);
    // 当前单 Plugin 兼容布局继续要求 Marketplace 根元数据与唯一 Plugin 一致。
    if (marketplace.plugins.length === 1
      && (marketplace.description !== plugin.description || marketplace.version !== plugin.version)) {
      report(context, 'CLAUDE_MARKETPLACE_METADATA_MISMATCH', 'Single-Plugin Marketplace description and version must match the bundled Plugin.', []);
    }
  }
}

/**
 * 验证 Claude Code 主 Plugin 或 Marketplace Distribution 的最终安装候选。
 *
 * @param context Core 已安全物化的只读候选上下文。
 */
export async function validateClaudeBundle(context: PlatformValidateContext): Promise<void> {
  if (context.candidate.unit.role !== 'distribution') {
    /** 主单元始终使用安装根固定 Plugin Manifest。 */
    const plugin = await readJson(context, PLUGIN_MANIFEST_PATH);
    if (plugin !== undefined)
      await validatePluginManifest(context, plugin);
    return;
  }
  /** Marketplace Distribution 额外需要的根清单。 */
  const marketplace = await readJson(context, MARKETPLACE_MANIFEST_PATH);
  if (marketplace !== undefined)
    await validateMarketplace(context, marketplace);
}
