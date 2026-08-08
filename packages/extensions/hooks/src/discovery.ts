import { promises as fs } from 'node:fs';
import path from 'node:path';
import type {
  ExtensionDiscoverContext,
  ExtensionValidateContext,
} from '@tokenroll/acplugin';
import {
  ANTIGRAVITY_PLATFORM_ID,
  CLAUDE_CODE_PLATFORM_ID,
  CODEX_PLATFORM_ID,
  CURSOR_PLATFORM_ID,
  HOOK_ID_PATTERN,
  OPENCODE_PLATFORM_ID,
  PI_PLATFORM_ID,
  PLATFORM_ID_PATTERN,
} from './constants.js';
import {
  CLAUDE_CODE_PLATFORM_EVENTS,
  HOOK_EVENTS,
  isHookDefinition,
  type HookDefinition,
  type HookEvent,
  type PlatformHookEvent,
} from './types.js';

/**
 * 按 UTF-16 code unit 比较 Hook 目录项，不依赖宿主 locale/ICU。
 *
 * @param left 左侧名称。
 * @param right 右侧名称。
 * @returns 与 Array.sort 约定一致的 -1、0 或 1。
 */
function compareCodeUnits(left: string, right: string): number {
  if (left === right)
    return 0;
  return left < right ? -1 : 1;
}

/** discover 阶段保存的 Hook ID、来源目录和已执行定义。 */
export interface DiscoveredHook {
  /** 从一级目录名称取得的稳定 Hook ID。 */
  readonly id: string;
  /** 当前 Hook 的绝对源码目录。 */
  readonly directory: string;
  /** 必需 `hook.ts` 描述文件的绝对路径。 */
  readonly sourcePath: string;
  /** 由 defineHook 创建并完成加载的作者定义。 */
  readonly definition: HookDefinition;
}

/** 非空 discover 结果，作为 Core 判断 Extension 拥有实际资源的信号。 */
export interface DiscoveredHooks {
  /** 按 Hook ID 稳定排序的发现结果。 */
  readonly hooks: readonly DiscoveredHook[];
}

/** validate 阶段读取的已配置 Platform 快照。 */
export interface HooksValidationEnvironment {
  /** 当前构建已配置且可接收平台事件或专属字段的 Platform ID。 */
  readonly configuredPlatforms: ReadonlySet<string>;
}

/** Hook 定义根节点允许作者声明的字段。 */
const HOOK_DEFINITION_FIELDS = new Set([
  'event',
  'matcher',
  'timeout',
  'statusMessage',
  'platforms',
  'run',
]);

/** Claude Code 单 Hook 平台覆盖允许的字段。 */
const CLAUDE_CODE_OPTION_FIELDS = new Set(['matcher', 'timeout', 'statusMessage']);

/** Codex 单 Hook 平台覆盖允许的字段。 */
const CODEX_OPTION_FIELDS = new Set([
  'matcher',
  'timeout',
  'statusMessage',
  'additionalContextLimit',
]);

/** 其余官方 Adapter 共同接受的执行选项字段。 */
const PORTABLE_OPTION_FIELDS = new Set(['matcher', 'timeout', 'statusMessage']);

/** 具有稳定 Platform 选项 Schema 的官方 Adapter ID。 */
const PORTABLE_OPTION_PLATFORMS = new Set([
  CURSOR_PLATFORM_ID,
  ANTIGRAVITY_PLATFORM_ID,
  OPENCODE_PLATFORM_ID,
  PI_PLATFORM_ID,
]);

/** 用于运行时验证的规范事件集合。 */
const HOOK_EVENT_SET = new Set<string>(HOOK_EVENTS);

/** 用于 Claude Code Adapter Schema 验证的平台专属事件集合。 */
const CLAUDE_CODE_EVENT_SET = new Set<string>(CLAUDE_CODE_PLATFORM_EVENTS);

/**
 * 兼容 TypeScript Loader 返回模块命名空间或已解包默认导出两种形态。
 *
 * @param value TypeScript 描述文件的加载结果。
 * @returns 存在 default 时返回 default，否则返回原值。
 */
function unwrapDefault(value: unknown): unknown {
  if (value !== null && typeof value === 'object' && 'default' in value)
    return (value as { readonly default: unknown }).default;
  return value;
}

/**
 * 把绝对描述文件路径转换为不泄露工程根的诊断位置。
 *
 * @param context 当前 discover 上下文。
 * @param sourcePath 需要报告的绝对来源路径。
 * @returns 以 srcDir 为基准且统一使用 POSIX 分隔符的位置。
 */
function sourceLocation(context: ExtensionDiscoverContext, sourcePath: string): string {
  /** 相对于规范源码根的安全报告路径。 */
  const relative = path.relative(context.srcDir, sourcePath).split(path.sep).join('/');
  return relative.startsWith('../') ? path.basename(sourcePath) : relative;
}

/**
 * 把 Hook 描述文件转换为相对于工程根的稳定诊断位置。
 *
 * @param context 当前 validate 上下文。
 * @param hook 需要报告位置的 Hook。
 * @returns 不包含宿主绝对目录的 POSIX 工程路径。
 */
function hookLocation(context: ExtensionValidateContext, hook: DiscoveredHook): string {
  return path.relative(context.project.root, hook.sourcePath).split(path.sep).join('/');
}

/**
 * 扫描并加载 `src/hooks/<id>/hook.ts` 作者格式。
 *
 * @param context Core 提供的隔离工作目录、源码根和 TypeScript Loader。
 * @param include 可选的显式 Hook ID 白名单。
 * @returns 没有选中资源时返回 undefined，否则返回稳定发现状态。
 */
export async function discoverHooks(
  context: ExtensionDiscoverContext,
  include?: ReadonlySet<string>,
): Promise<DiscoveredHooks | undefined> {
  /** Hooks Extension 独占的固定作者源码根。 */
  const root = path.join(context.srcDir, 'hooks');
  /** Hook 根目录中的一级目录项。 */
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch /** error 保存当前操作捕获的异常，供本阶段转换或恢复。 */ (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return undefined;
    throw error;
  }

  /** 成功加载并通过品牌检查的 Hook 定义。 */
  const hooks: DiscoveredHook[] = [];
  /** include 中已经在源码目录找到的 Hook ID。 */
  const includedIds = new Set<string>();
  for (const entry of entries.sort((left, right) => compareCodeUnits(left.name, right.name))) {
    /** 当前 Hook 候选目录的绝对路径。 */
    const directory = path.join(root, entry.name);
    if (!entry.isDirectory() || !HOOK_ID_PATTERN.test(entry.name)) {
      context.reportDiagnostic({
        code: 'HOOK_ENTRY_INVALID',
        severity: 'error',
        message: 'Hook entries must be one-level lowercase kebab-case directories.',
        location: { path: sourceLocation(context, directory) },
      });
      continue;
    }
    if (include !== undefined && !include.has(entry.name))
      continue;
    includedIds.add(entry.name);
    /** 当前 Hook 必需的 TypeScript 描述文件。 */
    const sourcePath = path.join(directory, 'hook.ts');
    try {
      /** Loader 执行并解包后的 Hook 定义候选值。 */
      const definition = unwrapDefault(await context.loadTypeScriptModule(sourcePath));
      if (!isHookDefinition(definition))
        throw new TypeError('Hook descriptor must use defineHook().');
      hooks.push(Object.freeze({ id: entry.name, directory, sourcePath, definition }));
    } catch {
      context.reportDiagnostic({
        code: 'HOOK_LOAD_FAILED',
        severity: 'error',
        message: `Hook "${entry.name}" descriptor could not be loaded or was not created by defineHook().`,
        location: { path: sourceLocation(context, sourcePath) },
      });
    }
  }

  if (include !== undefined) {
    /** id 表示当前显式 include 项，用于报告不存在的作者资源。 */
    for (const id of include) {
      if (!includedIds.has(id)) {
        context.reportDiagnostic({
          code: 'HOOK_INCLUDE_MISSING',
          severity: 'error',
          message: `Included Hook "${id}" does not exist under src/hooks.`,
          location: { path: `hooks/${id}` },
        });
      }
    }
  }

  /** 目录完全为空或 include 明确没有选择资源时不激活 Extension。 */
  const hasSelectedResource = hooks.length > 0 || includedIds.size > 0;
  return hasSelectedResource ? Object.freeze({ hooks: Object.freeze(hooks) }) : undefined;
}

/**
 * 判断未知值是否为不带自定义原型的普通对象。
 *
 * @param value 待验证的作者配置值。
 * @returns 值可安全按自有字段读取时返回 true。
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    return false;
  /** 候选对象的原型，用于拒绝类实例和其他可执行访问器容器。 */
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * 校验 matcher 的字符串形态和可执行正则语法。
 *
 * @param context Core 提供的诊断出口。
 * @param hook 当前 Hook 描述。
 * @param value 待验证的 matcher。
 * @param fieldPath matcher 所在的稳定字段路径。
 */
function validateMatcher(
  context: ExtensionValidateContext,
  hook: DiscoveredHook,
  value: unknown,
  fieldPath: readonly (string | number)[],
): void {
  if (typeof value !== 'string') {
    context.reportDiagnostic({
      code: 'HOOK_MATCHER_INVALID',
      severity: 'error',
      message: `Hook "${hook.id}" matcher must be a string.`,
      location: { path: hookLocation(context, hook) },
      fieldPath,
    });
    return;
  }
  if (value === '' || value === '*')
    return;
  try {
    /** matcher 需要能被两个默认平台的正则实现解析。 */
    const expression = new RegExp(value);
    void expression;
  } catch {
    context.reportDiagnostic({
      code: 'HOOK_MATCHER_INVALID',
      severity: 'error',
      message: `Hook "${hook.id}" matcher is not a valid regular expression.`,
      location: { path: hookLocation(context, hook) },
      fieldPath,
    });
  }
}

/**
 * 校验 timeout 是平台配置接受的正有限秒数。
 *
 * @param context Core 提供的诊断出口。
 * @param hook 当前 Hook 描述。
 * @param value 待验证的 timeout。
 * @param fieldPath timeout 所在的稳定字段路径。
 */
function validateTimeout(
  context: ExtensionValidateContext,
  hook: DiscoveredHook,
  value: unknown,
  fieldPath: readonly (string | number)[],
): void {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    context.reportDiagnostic({
      code: 'HOOK_TIMEOUT_INVALID',
      severity: 'error',
      message: `Hook "${hook.id}" timeout must be a positive finite number of seconds.`,
      location: { path: hookLocation(context, hook) },
      fieldPath,
    });
  }
}

/**
 * 校验状态消息是可安全展示的非空字符串。
 *
 * @param context Core 提供的诊断出口。
 * @param hook 当前 Hook 描述。
 * @param value 待验证的状态消息。
 * @param fieldPath 状态消息所在的稳定字段路径。
 */
function validateStatusMessage(
  context: ExtensionValidateContext,
  hook: DiscoveredHook,
  value: unknown,
  fieldPath: readonly (string | number)[],
): void {
  if (typeof value !== 'string' || value.trim().length === 0) {
    context.reportDiagnostic({
      code: 'HOOK_STATUS_MESSAGE_INVALID',
      severity: 'error',
      message: `Hook "${hook.id}" statusMessage must be a non-empty string.`,
      location: { path: hookLocation(context, hook) },
      fieldPath,
    });
  }
}

/**
 * 返回 Hook 实际声明的 Platform ID；规范事件没有单平台限制。
 *
 * @param event Hook 定义中的事件声明。
 * @returns 平台事件的 Platform ID，规范事件返回 undefined。
 */
export function platformForEvent(event: HookDefinition['event']): string | undefined {
  return typeof event === 'string' ? undefined : event.platform;
}

/**
 * 返回 Hook 在平台配置中使用的原生事件名。
 *
 * @param event Hook 定义中的事件声明。
 * @returns 规范事件字符串或平台事件的 name。
 */
export function eventName(event: HookDefinition['event']): string {
  return typeof event === 'string' ? event : event.name;
}

/**
 * 校验规范事件或显式平台限定事件，并应用 Adapter 已知事件集合。
 *
 * @param context Core 提供的诊断出口。
 * @param hook 当前 Hook 描述。
 * @param environment 当前构建配置的 Platform 快照。
 */
function validateEvent(
  context: ExtensionValidateContext,
  hook: DiscoveredHook,
  environment: HooksValidationEnvironment,
): void {
  /** 当前作者声明的事件值。 */
  const event = hook.definition.event;
  if (typeof event === 'string') {
    if (!HOOK_EVENT_SET.has(event)) {
      context.reportDiagnostic({
        code: 'HOOK_EVENT_UNSUPPORTED',
        severity: 'error',
        message: `Hook "${hook.id}" must use a canonical event or { platform, name } for a platform-only event.`,
        location: { path: hookLocation(context, hook) },
        fieldPath: ['event'],
      });
    }
    return;
  }
  if (!isPlainObject(event)
    || typeof event.platform !== 'string'
    || !PLATFORM_ID_PATTERN.test(event.platform)
    || typeof event.name !== 'string'
    || event.name.trim().length === 0
    || Object.keys(event).some(field => field !== 'platform' && field !== 'name')) {
    context.reportDiagnostic({
      code: 'HOOK_PLATFORM_EVENT_INVALID',
      severity: 'error',
      message: `Hook "${hook.id}" platform event must contain only a lowercase kebab-case platform and non-empty name.`,
      location: { path: hookLocation(context, hook) },
      fieldPath: ['event'],
    });
    return;
  }
  /** 已完成形态检查的平台事件。 */
  const platformEvent = event as PlatformHookEvent;
  if (!environment.configuredPlatforms.has(platformEvent.platform)) {
    context.reportDiagnostic({
      code: 'HOOK_PLATFORM_NOT_CONFIGURED',
      severity: 'error',
      message: `Hook "${hook.id}" targets unconfigured Platform "${platformEvent.platform}".`,
      location: { path: hookLocation(context, hook) },
      fieldPath: ['event', 'platform'],
    });
    return;
  }
  if (platformEvent.platform === CLAUDE_CODE_PLATFORM_ID) {
    if (HOOK_EVENT_SET.has(platformEvent.name)) {
      context.reportDiagnostic({
        code: 'HOOK_PLATFORM_EVENT_CANONICAL',
        severity: 'error',
        message: `Hook "${hook.id}" must declare canonical event "${platformEvent.name}" as a string.`,
        location: { path: hookLocation(context, hook) },
        fieldPath: ['event'],
      });
    } else if (!CLAUDE_CODE_EVENT_SET.has(platformEvent.name)) {
      context.reportDiagnostic({
        code: 'HOOK_PLATFORM_EVENT_UNSUPPORTED',
        severity: 'error',
        message: `Claude Code Adapter does not recognize Hook event "${platformEvent.name}".`,
        location: { path: hookLocation(context, hook) },
        fieldPath: ['event', 'name'],
      });
    }
    return;
  }
  context.reportDiagnostic({
    code: 'HOOK_PLATFORM_EVENT_UNSUPPORTED',
    severity: 'error',
    message: `Hooks Extension has no platform-only event schema for Platform "${platformEvent.platform}".`,
    location: { path: hookLocation(context, hook) },
    fieldPath: ['event'],
  });
}

/**
 * 校验一个 Platform 覆盖对象及其 Adapter 专属字段。
 *
 * @param context Core 提供的诊断出口。
 * @param hook 当前 Hook 描述。
 * @param platform 当前覆盖所属 Platform ID。
 * @param value 待验证的平台覆盖对象。
 */
function validatePlatformOptions(
  context: ExtensionValidateContext,
  hook: DiscoveredHook,
  platform: string,
  value: unknown,
): void {
  /** 当前 Platform 覆盖对象的字段路径前缀。 */
  const prefix = ['platforms', platform] as const;
  if (!isPlainObject(value)) {
    context.reportDiagnostic({
      code: 'HOOK_PLATFORM_OPTIONS_INVALID',
      severity: 'error',
      message: `Hook "${hook.id}" platforms.${platform} must be a plain object.`,
      location: { path: hookLocation(context, hook) },
      fieldPath: prefix,
    });
    return;
  }
  /** 当前官方 Adapter 允许的平台覆盖字段集合。 */
  const allowed = platform === CLAUDE_CODE_PLATFORM_ID
    ? CLAUDE_CODE_OPTION_FIELDS
    : platform === CODEX_PLATFORM_ID
      ? CODEX_OPTION_FIELDS
      : PORTABLE_OPTION_PLATFORMS.has(platform)
        ? PORTABLE_OPTION_FIELDS
        : undefined;
  if (allowed === undefined) {
    context.reportDiagnostic({
      code: 'HOOK_PLATFORM_SCHEMA_UNAVAILABLE',
      severity: 'error',
      message: `Hooks Extension has no option schema for Platform "${platform}".`,
      location: { path: hookLocation(context, hook) },
      fieldPath: prefix,
    });
    return;
  }
  /** field 表示当前平台覆盖项，用于拒绝 Adapter 不认识的协议字段。 */
  for (const field of Object.keys(value)) {
    if (!allowed.has(field)) {
      context.reportDiagnostic({
        code: 'HOOK_PLATFORM_FIELD_UNKNOWN',
        severity: 'error',
        message: `Hook "${hook.id}" platforms.${platform}.${field} is not supported by that Adapter.`,
        location: { path: hookLocation(context, hook) },
        fieldPath: [...prefix, field],
      });
    }
  }
  if (value.matcher !== undefined)
    validateMatcher(context, hook, value.matcher, [...prefix, 'matcher']);
  if (value.timeout !== undefined)
    validateTimeout(context, hook, value.timeout, [...prefix, 'timeout']);
  if (value.statusMessage !== undefined)
    validateStatusMessage(context, hook, value.statusMessage, [...prefix, 'statusMessage']);
  if (platform === CODEX_PLATFORM_ID && value.additionalContextLimit !== undefined
    && (typeof value.additionalContextLimit !== 'number'
      || !Number.isInteger(value.additionalContextLimit)
      || value.additionalContextLimit < 0)) {
    context.reportDiagnostic({
      code: 'HOOK_CONTEXT_LIMIT_INVALID',
      severity: 'error',
      message: `Hook "${hook.id}" Codex additionalContextLimit must be a non-negative integer.`,
      location: { path: hookLocation(context, hook) },
      fieldPath: [...prefix, 'additionalContextLimit'],
    });
  }
}

/**
 * 读取已通过普通对象校验的平台覆盖。
 *
 * @param hook 当前 Hook 描述。
 * @param platform 需要读取的 Platform ID。
 * @returns 可索引覆盖对象；缺失或形态无效时返回 undefined。
 */
export function platformOptions(
  hook: DiscoveredHook,
  platform: string,
): Readonly<Record<string, unknown>> | undefined {
  /** Hook 定义中的平台覆盖根节点。 */
  const platforms = hook.definition.platforms;
  if (!isPlainObject(platforms))
    return undefined;
  /** 指定 Platform 对应的覆盖候选。 */
  const value = platforms[platform];
  return isPlainObject(value) ? value : undefined;
}

/**
 * 校验 Hook 定义、平台范围和两个官方 Adapter Schema。
 *
 * @param context Core 提供的规范工程和诊断出口。
 * @param discovered discover 阶段得到的非空 Hooks 状态。
 * @param environment configResolved 阶段保存的平台快照。
 */
export async function validateHooks(
  context: ExtensionValidateContext,
  discovered: Readonly<DiscoveredHooks>,
  environment: HooksValidationEnvironment,
): Promise<void> {
  for (const hook of discovered.hooks) {
    /** field 表示当前定义的可枚举字段，用于阻断原始平台 Handler 协议。 */
    for (const field of Object.keys(hook.definition)) {
      if (!HOOK_DEFINITION_FIELDS.has(field)) {
        context.reportDiagnostic({
          code: 'HOOK_FIELD_UNKNOWN',
          severity: 'error',
          message: `Hook "${hook.id}" field "${field}" is not part of the canonical authoring contract.`,
          location: { path: hookLocation(context, hook) },
          fieldPath: [field],
          hint: 'Implement behavior inside run(); raw command, executable, HTTP, prompt, agent, and MCP-tool handlers are not accepted.',
        });
      }
    }
    validateEvent(context, hook, environment);
    if (typeof hook.definition.run !== 'function') {
      context.reportDiagnostic({
        code: 'HOOK_RUN_REQUIRED',
        severity: 'error',
        message: `Hook "${hook.id}" must define run().`,
        location: { path: hookLocation(context, hook) },
        fieldPath: ['run'],
      });
    }
    if (hook.definition.matcher !== undefined)
      validateMatcher(context, hook, hook.definition.matcher, ['matcher']);
    if (hook.definition.timeout !== undefined)
      validateTimeout(context, hook, hook.definition.timeout, ['timeout']);
    if (hook.definition.statusMessage !== undefined)
      validateStatusMessage(context, hook, hook.definition.statusMessage, ['statusMessage']);

    /** 当前 Hook 可选的平台专属补充字段根节点。 */
    const platforms = hook.definition.platforms;
    if (platforms !== undefined && !isPlainObject(platforms)) {
      context.reportDiagnostic({
        code: 'HOOK_PLATFORMS_INVALID',
        severity: 'error',
        message: `Hook "${hook.id}" platforms must be a plain object keyed by Platform ID.`,
        location: { path: hookLocation(context, hook) },
        fieldPath: ['platforms'],
      });
      continue;
    }
    if (platforms !== undefined) {
      for (const [platform, value] of Object.entries(platforms)) {
        if (!environment.configuredPlatforms.has(platform)) {
          context.reportDiagnostic({
            code: 'HOOK_PLATFORM_NOT_CONFIGURED',
            severity: 'error',
            message: `Hook "${hook.id}" configures unconfigured Platform "${platform}".`,
            location: { path: hookLocation(context, hook) },
            fieldPath: ['platforms', platform],
          });
          continue;
        }
        /** 平台限定事件不能向其他平台附加无效覆盖。 */
        const eventPlatform = platformForEvent(hook.definition.event);
        if (eventPlatform !== undefined && eventPlatform !== platform) {
          context.reportDiagnostic({
            code: 'HOOK_PLATFORM_EVENT_SCOPE_INVALID',
            severity: 'error',
            message: `Hook "${hook.id}" is limited to "${eventPlatform}" and cannot configure "${platform}".`,
            location: { path: hookLocation(context, hook) },
            fieldPath: ['platforms', platform],
          });
          continue;
        }
        validatePlatformOptions(context, hook, platform, value);
      }
    }

    /** Codex 实际采用的超时值，用于落实 SessionEnd 官方三秒上限。 */
    const codexTimeout = platformOptions(hook, CODEX_PLATFORM_ID)?.timeout ?? hook.definition.timeout;
    /** 当前事件的规范或平台原生名称。 */
    const name = eventName(hook.definition.event);
    /** 当前 Hook 是否会交给 Codex Adapter。 */
    const appliesToCodex = platformForEvent(hook.definition.event) === undefined
      || platformForEvent(hook.definition.event) === CODEX_PLATFORM_ID;
    if (name === 'SessionEnd'
      && appliesToCodex
      && environment.configuredPlatforms.has(CODEX_PLATFORM_ID)
      && typeof codexTimeout === 'number'
      && codexTimeout > 3) {
      context.reportDiagnostic({
        code: 'HOOK_TIMEOUT_PLATFORM_LIMIT',
        severity: 'error',
        message: `Hook "${hook.id}" exceeds Codex SessionEnd's 3 second maximum.`,
        location: { path: hookLocation(context, hook) },
        fieldPath: ['platforms', CODEX_PLATFORM_ID, 'timeout'],
      });
    }
    /** Claude Code 实际采用的超时值，用于落实 SessionEnd 官方六十秒上限。 */
    const claudeTimeout = platformOptions(hook, CLAUDE_CODE_PLATFORM_ID)?.timeout ?? hook.definition.timeout;
    /** 当前 Hook 是否会交给 Claude Code Adapter。 */
    const appliesToClaude = platformForEvent(hook.definition.event) === undefined
      || platformForEvent(hook.definition.event) === CLAUDE_CODE_PLATFORM_ID;
    if (name === 'SessionEnd'
      && appliesToClaude
      && environment.configuredPlatforms.has(CLAUDE_CODE_PLATFORM_ID)
      && typeof claudeTimeout === 'number'
      && claudeTimeout > 60) {
      context.reportDiagnostic({
        code: 'HOOK_TIMEOUT_PLATFORM_LIMIT',
        severity: 'error',
        message: `Hook "${hook.id}" exceeds Claude Code SessionEnd's 60 second maximum.`,
        location: { path: hookLocation(context, hook) },
        fieldPath: ['platforms', CLAUDE_CODE_PLATFORM_ID, 'timeout'],
      });
    }
  }
}

/** 供 Adapter 和 Runner 识别规范事件的只读集合。 */
export const CANONICAL_HOOK_EVENT_SET: ReadonlySet<HookEvent> = new Set(HOOK_EVENTS);
