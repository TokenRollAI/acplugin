import type {
  ExtensionDiscoverContext,
  ExtensionValidateContext,
  JsonValue,
  SourceDirectoryRef,
  SourceFileRef,
} from '@tokenroll/acplugin/sdk';
import {
  CLAUDE_CODE_PLATFORM_ID,
  CODEX_PLATFORM_ID,
  HOOK_ID_PATTERN,
  PLATFORM_ID_PATTERN,
} from './constants.js';
import {
  CLAUDE_CODE_PLATFORM_EVENTS,
  HOOK_EVENTS,
  type HookEvent,
  type HookEventDeclaration,
} from './types.js';

/** Hook descriptor 顶层唯一允许的作者字段。 */
const HOOK_FIELDS = new Set(['event', 'matcher', 'timeout', 'statusMessage', 'platforms', 'run']);

/** Claude Code 单 Hook 覆盖允许的字段。 */
const CLAUDE_FIELDS = new Set(['matcher', 'timeout', 'statusMessage']);

/** Codex 单 Hook 覆盖允许的字段。 */
const CODEX_FIELDS = new Set(['matcher', 'timeout', 'statusMessage', 'additionalContextLimit']);

/** 其余官方 Contributor 共同接受的字段。 */
const PORTABLE_FIELDS = new Set(['matcher', 'timeout', 'statusMessage']);

/** 拥有固定平台覆盖 Schema 的官方 Platform。 */
const OFFICIAL_PLATFORMS = new Set(['claude-code', 'codex', 'cursor', 'antigravity', 'opencode', 'pi']);

/** 规范 Hook 事件的运行时集合。 */
const EVENT_SET = new Set<string>(HOOK_EVENTS);

/** Claude Code 平台限定事件的运行时集合。 */
const CLAUDE_EVENT_SET = new Set<string>(CLAUDE_CODE_PLATFORM_EVENTS);

/** State 中不包含 `run` 的纯数据 Hook descriptor。 */
export interface HookDescriptorData {
  readonly event: JsonValue;
  readonly matcher?: JsonValue;
  readonly timeout?: JsonValue;
  readonly statusMessage?: JsonValue;
  readonly platforms?: JsonValue;
  readonly unknownFields: readonly string[];
  readonly runValid: boolean;
}

/** discover/validate 阶段使用的 owner-bound Hook 来源。 */
export interface DiscoveredHook {
  readonly id: string;
  readonly location: string;
  readonly directory: SourceDirectoryRef;
  readonly source: SourceFileRef;
  readonly definition: HookDescriptorData;
}

/** Hooks Extension 的非空 discovered State。 */
export interface DiscoveredHooks {
  readonly root: SourceDirectoryRef;
  readonly hooks: readonly DiscoveredHook[];
}

/** validation 通过后仍保持纯数据和 SourceRef 的 State。 */
export type ValidatedHooks = DiscoveredHooks;

/** @returns 未知值是否为不带行为的普通对象。 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    return false;
  /** prototype 用于拒绝 class、Date、Map 等可执行容器。 */
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** 深度复制一个无 accessor、Symbol、cycle 或 executable 的 JSON 值。 */
function copyJson(value: unknown, path: string, ancestors = new Set<object>()): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean')
    return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value))
      throw new TypeError(`${path} must be finite.`);
    return value;
  }
  if (typeof value !== 'object')
    throw new TypeError(`${path} must contain JSON data.`);
  if (ancestors.has(value))
    throw new TypeError(`${path} must not contain cycles.`);
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      /** 数组索引必须稠密且不能携带隐藏自定义字段。 */
      const descriptors = Object.getOwnPropertyDescriptors(value);
      if (Object.getOwnPropertySymbols(value).length > 0)
        throw new TypeError(`${path} arrays must not contain symbol fields.`);
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index))
          throw new TypeError(`${path} must not contain sparse arrays.`);
      }
      if (Object.keys(descriptors).some(field => field !== 'length'
        && (!/^(?:0|[1-9][0-9]*)$/u.test(field) || Number(field) >= value.length)))
        throw new TypeError(`${path} arrays must not contain custom fields.`);
      /** 逐索引读取 data descriptor，绝不通过 Array.prototype.map 触发 getter。 */
      const result: JsonValue[] = [];
      for (let index = 0; index < value.length; index += 1) {
        /** 稠密索引必须仍是显式 data property。 */
        const descriptor = descriptors[String(index)]!;
        if (!('value' in descriptor))
          throw new TypeError(`${path}[${index}] must be a data property.`);
        result.push(copyJson(descriptor.value, `${path}[${index}]`, ancestors));
      }
      return Object.freeze(result);
    }
    if (!isPlainObject(value) || Object.getOwnPropertySymbols(value).length > 0)
      throw new TypeError(`${path} must be a plain JSON object.`);
    /** descriptor 读取保证 getter 在任何阶段都不会执行。 */
    const descriptors = Object.getOwnPropertyDescriptors(value);
    /** result 与作者后续 mutation 完全断开。 */
    const result: Record<string, JsonValue> = {};
    for (const field of Object.keys(descriptors).sort()) {
      /** 当前字段必须是显式 data property。 */
      const descriptor = descriptors[field]!;
      if (!('value' in descriptor))
        throw new TypeError(`${path}.${field} must be a data property.`);
      if (descriptor.value === undefined)
        throw new TypeError(`${path}.${field} must not be undefined.`);
      result[field] = copyJson(descriptor.value, `${path}.${field}`, ancestors);
    }
    return Object.freeze(result);
  } finally {
    ancestors.delete(value);
  }
}

/** 把已加载作者模块转换为不包含 `run` 的 immutable descriptor State。 */
function descriptorData(value: unknown): HookDescriptorData {
  if (!isPlainObject(value) || Object.getOwnPropertySymbols(value).length > 0)
    throw new TypeError('Hook descriptor must be a plain object.');
  /** fields 只通过 descriptors 读取，禁止 non-enumerable accessor 隐藏语义。 */
  const fields = Object.getOwnPropertyDescriptors(value);
  if (Object.values(fields).some(descriptor => !('value' in descriptor)))
    throw new TypeError('Hook descriptor fields must be data properties.');
  /** unknownFields 只保留字段名，未知值不会进入跨阶段 State。 */
  const unknownFields = Object.keys(fields).filter(field => !HOOK_FIELDS.has(field)).sort();
  /** result 主动移除唯一可执行字段 run。 */
  return Object.freeze({
    event: fields.event === undefined || fields.event.value === undefined
      ? null
      : copyJson(fields.event.value, 'Hook.event'),
    ...(fields.matcher === undefined || fields.matcher.value === undefined
      ? {}
      : { matcher: copyJson(fields.matcher.value, 'Hook.matcher') }),
    ...(fields.timeout === undefined || fields.timeout.value === undefined
      ? {}
      : { timeout: copyJson(fields.timeout.value, 'Hook.timeout') }),
    ...(fields.statusMessage === undefined || fields.statusMessage.value === undefined
      ? {}
      : { statusMessage: copyJson(fields.statusMessage.value, 'Hook.statusMessage') }),
    ...(fields.platforms === undefined || fields.platforms.value === undefined
      ? {}
      : { platforms: copyJson(fields.platforms.value, 'Hook.platforms') }),
    unknownFields: Object.freeze(unknownFields),
    runValid: typeof fields.run?.value === 'function',
  });
}

/** 发现、加载并去函数化 `src/hooks/<id>/hook.ts`。 */
export async function discoverHooks(
  context: ExtensionDiscoverContext,
  include?: ReadonlySet<string>,
): Promise<DiscoveredHooks | undefined> {
  /** hooks 是 Resource Registry 为当前 Extension 独占签发的根。 */
  const root = context.roots.hooks;
  if (root === undefined)
    return undefined;
  /** 顶层 entries 已经过 Source Registry 的 symlink/special/collision 审计。 */
  const entries = await context.sources.list(root);
  /** hooks 只保存成功加载且被 include 选中的 descriptor。 */
  const hooks: DiscoveredHook[] = [];
  /** found 用于精确报告 include 中不存在的资源。 */
  const found = new Set<string>();
  for (const entry of entries) {
    if (entry.type !== 'directory' || !HOOK_ID_PATTERN.test(entry.name)) {
      context.diagnostics.report({
        code: 'HOOK_ENTRY_INVALID',
        severity: 'error',
        message: 'Hook entries must be one-level lowercase kebab-case directories.',
        location: { path: entry.path },
      });
      continue;
    }
    if (include !== undefined && !include.has(entry.name))
      continue;
    found.add(entry.name);
    try {
      /** source 是作者格式唯一入口；同目录依赖由 Module/Compiler Host 图审计。 */
      const source = await context.sources.file(entry.directory, 'hook.ts');
      /** raw 只在当前调用栈内存在，run 不进入返回 State。 */
      const raw = await context.modules.loadDefault({ id: `hook-${entry.name}`, entry: source });
      hooks.push(Object.freeze({
        id: entry.name,
        location: source.path,
        directory: entry.directory,
        source,
        definition: descriptorData(raw),
      }));
    } catch {
      context.diagnostics.report({
        code: 'HOOK_LOAD_FAILED',
        severity: 'error',
        message: `Hook "${entry.name}" must provide a safe plain default-exported descriptor in hook.ts.`,
        location: { path: `${entry.path}/hook.ts` },
      });
    }
  }
  if (include !== undefined) {
    for (const id of include) {
      if (!found.has(id)) {
        context.diagnostics.report({
          code: 'HOOK_INCLUDE_MISSING',
          severity: 'error',
          message: `Included Hook "${id}" does not exist under src/hooks.`,
          location: { path: `${root.path}/${id}` },
        });
      }
    }
  }
  return hooks.length === 0 ? undefined : Object.freeze({ root, hooks: Object.freeze(hooks) });
}

/** 提交一个绑定 Hook 来源和字段的 validate 诊断。 */
function error(
  context: ExtensionValidateContext,
  hook: DiscoveredHook,
  code: string,
  message: string,
  fieldPath?: readonly (string | number)[],
): void {
  context.diagnostics.report({
    code,
    severity: 'error',
    message,
    location: { path: hook.location },
    ...(fieldPath === undefined ? {} : { fieldPath }),
  });
}

/** 校验 matcher 语法与稳定字符串类型。 */
function validateMatcher(context: ExtensionValidateContext, hook: DiscoveredHook, value: JsonValue, fieldPath: readonly string[]): void {
  if (typeof value !== 'string') {
    error(context, hook, 'HOOK_MATCHER_INVALID', `Hook "${hook.id}" matcher must be a string.`, fieldPath);
    return;
  }
  if (value === '' || value === '*')
    return;
  try {
    /** 实际 Contributor runtime 使用 JavaScript RegExp。 */
    void new RegExp(value);
  } catch {
    error(context, hook, 'HOOK_MATCHER_INVALID', `Hook "${hook.id}" matcher is not a valid regular expression.`, fieldPath);
  }
}

/** 校验 timeout 是正有限秒数。 */
function validateTimeout(context: ExtensionValidateContext, hook: DiscoveredHook, value: JsonValue, fieldPath: readonly string[]): void {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0)
    error(context, hook, 'HOOK_TIMEOUT_INVALID', `Hook "${hook.id}" timeout must be a positive finite number of seconds.`, fieldPath);
}

/** 校验 statusMessage 是非空展示文本。 */
function validateStatus(context: ExtensionValidateContext, hook: DiscoveredHook, value: JsonValue, fieldPath: readonly string[]): void {
  if (typeof value !== 'string' || value.trim().length === 0)
    error(context, hook, 'HOOK_STATUS_MESSAGE_INVALID', `Hook "${hook.id}" statusMessage must be a non-empty string.`, fieldPath);
}

/** @returns descriptor 已验证事件的统一名称。 */
export function eventName(definition: HookDescriptorData): string {
  return typeof definition.event === 'string'
    ? definition.event
    : String((definition.event as Record<string, JsonValue> | null)?.name ?? 'unknown');
}

/** 把规范事件映射为兼容性 ID 使用的小写 kebab-case。 */
export function eventCapability(definition: HookDescriptorData): string {
  return eventName(definition).replace(/([a-z0-9])([A-Z])/gu, '$1-$2').toLowerCase();
}

/** @returns descriptor 平台限定事件的目标 Platform。 */
export function platformForEvent(definition: HookDescriptorData): string | undefined {
  return typeof definition.event === 'object' && definition.event !== null && !Array.isArray(definition.event)
    ? typeof (definition.event as Record<string, JsonValue>).platform === 'string'
      ? (definition.event as Record<string, JsonValue>).platform as string
      : undefined
    : undefined;
}

/** @returns 当前 Platform 已验证的覆盖对象。 */
export function platformOptions(definition: HookDescriptorData, platform: string): Readonly<Record<string, JsonValue>> | undefined {
  if (!isPlainObject(definition.platforms))
    return undefined;
  /** value 是 copyJson 生成的 JSON object。 */
  const value = definition.platforms[platform];
  return isPlainObject(value) ? value as Readonly<Record<string, JsonValue>> : undefined;
}

/** @returns descriptor 的事件可安全交给类型化运行时代码。 */
export function hookEvent(definition: HookDescriptorData): HookEventDeclaration {
  return definition.event as unknown as HookEventDeclaration;
}

/** 校验一个 Hook 的事件、plain fields、平台范围和受控 options。 */
function validateHook(
  context: ExtensionValidateContext,
  hook: DiscoveredHook,
  configuredPlatforms: ReadonlySet<string>,
): void {
  for (const field of hook.definition.unknownFields) {
    error(context, hook, 'HOOK_FIELD_UNKNOWN', `Hook "${hook.id}" field "${field}" is not part of the authoring contract.`, [field]);
  }
  if (!hook.definition.runValid)
    error(context, hook, 'HOOK_RUN_REQUIRED', `Hook "${hook.id}" must define run().`, ['run']);
  /** event 在 plain JSON State 中验证 canonical 或显式单平台形态。 */
  const event = hook.definition.event;
  if (typeof event === 'string') {
    if (!EVENT_SET.has(event))
      error(context, hook, 'HOOK_EVENT_UNSUPPORTED', `Hook "${hook.id}" must use a canonical event or an explicit platform event.`, ['event']);
  } else if (!isPlainObject(event)
    || Object.keys(event).some(field => field !== 'platform' && field !== 'name')
    || typeof event.platform !== 'string'
    || !PLATFORM_ID_PATTERN.test(event.platform)
    || typeof event.name !== 'string'
    || event.name.trim().length === 0) {
    error(context, hook, 'HOOK_PLATFORM_EVENT_INVALID', `Hook "${hook.id}" platform event must contain only platform and name.`, ['event']);
  } else if (!configuredPlatforms.has(event.platform)) {
    error(context, hook, 'HOOK_PLATFORM_NOT_CONFIGURED', `Hook "${hook.id}" targets unconfigured Platform "${event.platform}".`, ['event', 'platform']);
  } else if (event.platform !== CLAUDE_CODE_PLATFORM_ID || !CLAUDE_EVENT_SET.has(event.name) || EVENT_SET.has(event.name)) {
    error(context, hook, 'HOOK_PLATFORM_EVENT_UNSUPPORTED', `Hook "${hook.id}" uses an unsupported platform-only event.`, ['event']);
  }
  if (hook.definition.matcher !== undefined)
    validateMatcher(context, hook, hook.definition.matcher, ['matcher']);
  if (hook.definition.timeout !== undefined)
    validateTimeout(context, hook, hook.definition.timeout, ['timeout']);
  if (hook.definition.statusMessage !== undefined)
    validateStatus(context, hook, hook.definition.statusMessage, ['statusMessage']);
  if (hook.definition.platforms !== undefined && !isPlainObject(hook.definition.platforms)) {
    error(context, hook, 'HOOK_PLATFORMS_INVALID', `Hook "${hook.id}" platforms must be an object.`, ['platforms']);
    return;
  }
  for (const [platform, value] of Object.entries(hook.definition.platforms ?? {})) {
    if (!configuredPlatforms.has(platform)) {
      error(context, hook, 'HOOK_PLATFORM_NOT_CONFIGURED', `Hook "${hook.id}" configures unconfigured Platform "${platform}".`, ['platforms', platform]);
      continue;
    }
    if (!OFFICIAL_PLATFORMS.has(platform) || !isPlainObject(value)) {
      error(context, hook, 'HOOK_PLATFORM_OPTIONS_INVALID', `Hook "${hook.id}" has no valid option schema for Platform "${platform}".`, ['platforms', platform]);
      continue;
    }
    /** allowed 是当前官方 Contributor 的精确字段集合。 */
    const allowed = platform === CLAUDE_CODE_PLATFORM_ID ? CLAUDE_FIELDS : platform === CODEX_PLATFORM_ID ? CODEX_FIELDS : PORTABLE_FIELDS;
    for (const field of Object.keys(value)) {
      if (!allowed.has(field))
        error(context, hook, 'HOOK_PLATFORM_FIELD_UNKNOWN', `Hook "${hook.id}" platforms.${platform}.${field} is unsupported.`, ['platforms', platform, field]);
    }
    if (value.matcher !== undefined)
      validateMatcher(context, hook, value.matcher as JsonValue, ['platforms', platform, 'matcher']);
    if (value.timeout !== undefined)
      validateTimeout(context, hook, value.timeout as JsonValue, ['platforms', platform, 'timeout']);
    if (value.statusMessage !== undefined)
      validateStatus(context, hook, value.statusMessage as JsonValue, ['platforms', platform, 'statusMessage']);
    if (platform === CODEX_PLATFORM_ID && value.additionalContextLimit !== undefined
      && (typeof value.additionalContextLimit !== 'number' || !Number.isInteger(value.additionalContextLimit) || value.additionalContextLimit < 0)) {
      error(context, hook, 'HOOK_CONTEXT_LIMIT_INVALID', `Hook "${hook.id}" Codex additionalContextLimit must be a non-negative integer.`, ['platforms', platform, 'additionalContextLimit']);
    }
  }
  /** SessionEnd 使用两个官方平台公开的硬超时上限。 */
  if (eventName(hook.definition) === 'SessionEnd') {
    /** codexTimeout 是覆盖或顶层的最终值。 */
    const codexTimeout = platformOptions(hook.definition, CODEX_PLATFORM_ID)?.timeout ?? hook.definition.timeout;
    if (configuredPlatforms.has(CODEX_PLATFORM_ID) && typeof codexTimeout === 'number' && codexTimeout > 3)
      error(context, hook, 'HOOK_TIMEOUT_PLATFORM_LIMIT', `Hook "${hook.id}" exceeds Codex SessionEnd's 3 second maximum.`, ['platforms', CODEX_PLATFORM_ID, 'timeout']);
    /** claudeTimeout 是覆盖或顶层的最终值。 */
    const claudeTimeout = platformOptions(hook.definition, CLAUDE_CODE_PLATFORM_ID)?.timeout ?? hook.definition.timeout;
    if (configuredPlatforms.has(CLAUDE_CODE_PLATFORM_ID) && typeof claudeTimeout === 'number' && claudeTimeout > 60)
      error(context, hook, 'HOOK_TIMEOUT_PLATFORM_LIMIT', `Hook "${hook.id}" exceeds Claude Code SessionEnd's 60 second maximum.`, ['platforms', CLAUDE_CODE_PLATFORM_ID, 'timeout']);
  }
}

/** 验证全部 Hook 并声明每个事件 tuple 的跨 Platform 覆盖合同。 */
export function validateHooks(
  context: ExtensionValidateContext,
  discovered: Readonly<DiscoveredHooks>,
  configuredPlatforms: ReadonlySet<string>,
): { readonly state: ValidatedHooks; readonly subjects: readonly { readonly subject: string; readonly capabilities: readonly string[] }[] } {
  for (const hook of discovered.hooks)
    validateHook(context, hook, configuredPlatforms);
  /** 每个 Hook 的 event capability 必须由每个选中 Platform Contributor 精确覆盖。 */
  const subjects = discovered.hooks.map(hook => Object.freeze({
    subject: `hook:${hook.id}`,
    capabilities: Object.freeze([`event.${eventCapability(hook.definition)}`]),
  }));
  return Object.freeze({ state: discovered, subjects: Object.freeze(subjects) });
}

/** 供 Contributor 的固定规范事件类型守卫。 */
export function isCanonicalEvent(value: string): value is HookEvent {
  return EVENT_SET.has(value);
}
