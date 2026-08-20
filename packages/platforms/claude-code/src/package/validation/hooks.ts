/** Claude Code Hook wire contract validator。 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { JsonValue } from '@tokenroll/acplugin/sdk';
import {
  isRecord,
  report,
  type JsonRecord,
  type PlatformValidateContext,
} from './shared.js';

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

/**
 * 校验 Claude Code Hook matcher 是可执行的正则字符串。
 *
 * @param context Platform validatePackage 生命周期上下文。
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
 * @param context Platform validatePackage 生命周期上下文。
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
 * @param context Platform validatePackage 生命周期上下文。
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
 * @param context Platform validatePackage 生命周期上下文。
 * @param value 已解析的 Hook 配置对象。
 * @param fieldPath 配置在 Plugin Manifest 中的字段路径。
 * @param wrapped 是否要求配置使用 `hooks.json` 顶层包装。
 */
export function validateHookConfig(
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
 * @param context Platform validatePackage 生命周期上下文。
 * @param pluginRoot Plugin 相对于候选 Distribution 根的安装目录。
 * @param reference 已通过安装根路径规则的 Hook 配置引用。
 * @param fieldPath 引用在 Plugin Manifest 中的字段路径。
 */
export async function validateHookFile(
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
