/** Codex Hook wire contract validator。 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { JsonValue } from '@tokenroll/acplugin/sdk';
import {
  isRecord,
  isSafePluginReference,
  referenceExists,
  report,
  validateReference,
  type JsonRecord,
  type PlatformValidateContext,
} from './shared.js';

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

/**
 * 校验 Codex Hook matcher 是可执行的正则字符串。
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
 * @param context Platform validatePackage 生命周期上下文。
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
 * @param context Platform validatePackage 生命周期上下文。
 * @param assets 当前 Package 的 Asset 路径集合。
 * @param pluginRoot Plugin 相对于候选 Distribution 根的安装目录。
 * @param value Hooks 字段候选。
 */
export async function validateHooks(
  context: PlatformValidateContext,
  assets: ReadonlySet<string>,
  pluginRoot: string,
  value: JsonValue,
): Promise<void> {
  /** 校验并读取单个 Plugin 根路径引用。 */
  const validatePath = async (reference: string, fieldPath: readonly (string | number)[]): Promise<void> => {
    validateReference(context, assets, 'hooks', reference, fieldPath);
    if (isSafePluginReference(reference) && referenceExists(assets, reference))
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
