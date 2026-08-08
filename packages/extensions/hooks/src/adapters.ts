import {
  bytesArtifact,
  stableJson,
  type ExtensionPlatformAdapter,
  type JsonValue,
  type PlatformAdapterContext,
  type PlatformId,
} from '@tokenroll/acplugin';
import type { BuiltHooks, BundledHook } from './bundler.js';
import {
  ANTIGRAVITY_PLATFORM_ID,
  CLAUDE_CODE_PLATFORM_ID,
  CODEX_PLATFORM_ID,
  CURSOR_PLATFORM_ID,
  HOOKS_MANIFEST_PATH,
  OPENCODE_PLATFORM_ID,
  PI_PLATFORM_ID,
  PLUGIN_MANIFEST_ID,
} from './constants.js';
import { eventName, platformForEvent } from './discovery.js';
import {
  createOpenCodePluginSource,
  createPiExtensionSource,
  runtimeHookDescriptor,
} from './runtime-adapter-source.js';
import { createWireSource } from './wire-source.js';

/** Adapter 合并顶层默认值与 Platform 补充字段后的执行配置。 */
interface ResolvedHookOptions {
  /** 当前 Platform 实际采用的 matcher。 */
  readonly matcher?: string;
  /** 当前 Platform 实际采用的超时秒数。 */
  readonly timeout?: number;
  /** 当前 Platform 实际显示的状态消息。 */
  readonly statusMessage?: string;
  /** Codex 可选的上下文直接注入 Token 上限。 */
  readonly additionalContextLimit?: number;
}

/** 单个 Hook 配置文件中的事件分组。 */
interface HookGroup {
  /** 可选的平台匹配表达式。 */
  readonly matcher?: string;
  /** 当前匹配分组内的一个受控 command Handler。 */
  readonly hooks: readonly Readonly<Record<string, JsonValue>>[];
}

/** 非默认 Platform 对一个规范事件的实际支持结论。 */
interface HookEventSupport {
  /** Adapter 是否生成可运行产物。 */
  readonly supported: boolean;
  /** 生成产物时的兼容性等级。 */
  readonly level: 'native' | 'transform' | 'degraded' | 'unsupported';
  /** 平台原生事件名称。 */
  readonly nativeEvent?: string;
  /** 稳定且面向作者的结论原因。 */
  readonly reason: string;
}

/** Cursor 对 11 个规范事件的固定映射。 */
const CURSOR_EVENTS: Readonly<Record<string, HookEventSupport>> = Object.freeze({
  SessionStart: { supported: true, level: 'transform', nativeEvent: 'sessionStart', reason: 'Cursor provides a corresponding sessionStart command Hook.' },
  SessionEnd: { supported: true, level: 'transform', nativeEvent: 'sessionEnd', reason: 'Cursor provides a corresponding sessionEnd command Hook.' },
  UserPromptSubmit: { supported: true, level: 'transform', nativeEvent: 'beforeSubmitPrompt', reason: 'Cursor beforeSubmitPrompt preserves the prompt submission trigger.' },
  PreToolUse: { supported: true, level: 'transform', nativeEvent: 'preToolUse', reason: 'Cursor preToolUse preserves the before-tool trigger.' },
  PermissionRequest: { supported: false, level: 'unsupported', reason: 'Cursor has no verified Plugin Hook for a distinct permission request.' },
  PostToolUse: { supported: true, level: 'transform', nativeEvent: 'postToolUse', reason: 'Cursor postToolUse preserves the after-tool trigger.' },
  PreCompact: { supported: true, level: 'transform', nativeEvent: 'preCompact', reason: 'Cursor preCompact preserves the pre-compaction trigger.' },
  PostCompact: { supported: false, level: 'unsupported', reason: 'Cursor has no verified post-compaction Plugin Hook.' },
  SubagentStart: { supported: true, level: 'transform', nativeEvent: 'subagentStart', reason: 'Cursor subagentStart preserves the subagent start trigger.' },
  SubagentStop: { supported: true, level: 'transform', nativeEvent: 'subagentStop', reason: 'Cursor subagentStop preserves the subagent stop trigger.' },
  Stop: { supported: true, level: 'transform', nativeEvent: 'stop', reason: 'Cursor stop preserves the agent stop trigger.' },
});

/** Antigravity 对 11 个规范事件的固定映射。 */
const ANTIGRAVITY_EVENTS: Readonly<Record<string, HookEventSupport>> = Object.freeze({
  SessionStart: { supported: true, level: 'native', nativeEvent: 'SessionStart', reason: 'Antigravity supports SessionStart command Hooks.' },
  SessionEnd: { supported: true, level: 'native', nativeEvent: 'SessionEnd', reason: 'Antigravity supports SessionEnd command Hooks.' },
  UserPromptSubmit: { supported: false, level: 'unsupported', reason: 'Antigravity has no documented prompt-submit Hook.' },
  PreToolUse: { supported: true, level: 'native', nativeEvent: 'PreToolUse', reason: 'Antigravity supports PreToolUse command Hooks.' },
  PermissionRequest: { supported: false, level: 'unsupported', reason: 'Antigravity has no distinct permission request Hook.' },
  PostToolUse: { supported: true, level: 'native', nativeEvent: 'PostToolUse', reason: 'Antigravity supports PostToolUse command Hooks.' },
  PreCompact: { supported: true, level: 'native', nativeEvent: 'PreCompact', reason: 'Antigravity supports PreCompact command Hooks.' },
  PostCompact: { supported: false, level: 'unsupported', reason: 'Antigravity has no documented post-compaction Hook.' },
  SubagentStart: { supported: false, level: 'unsupported', reason: 'Antigravity has no documented subagent start Hook.' },
  SubagentStop: { supported: false, level: 'unsupported', reason: 'Antigravity has no documented subagent stop Hook.' },
  Stop: { supported: false, level: 'unsupported', reason: 'Antigravity has no documented stop Hook.' },
});

/** OpenCode runtime Plugin 对 11 个规范事件的固定映射。 */
const OPENCODE_EVENTS: Readonly<Record<string, HookEventSupport>> = Object.freeze({
  SessionStart: { supported: true, level: 'native', nativeEvent: 'session.created', reason: 'OpenCode exposes the session.created runtime event.' },
  SessionEnd: { supported: true, level: 'degraded', nativeEvent: 'session.deleted', reason: 'OpenCode session.deleted is observable but cannot preserve every completion result.' },
  UserPromptSubmit: { supported: true, level: 'native', nativeEvent: 'chat.message', reason: 'OpenCode exposes a mutable chat.message Hook.' },
  PreToolUse: { supported: true, level: 'native', nativeEvent: 'tool.execute.before', reason: 'OpenCode exposes a mutable before-tool Hook.' },
  PermissionRequest: { supported: false, level: 'unsupported', reason: 'OpenCode has no stable runtime Hook for a distinct permission request.' },
  PostToolUse: { supported: true, level: 'native', nativeEvent: 'tool.execute.after', reason: 'OpenCode exposes an after-tool Hook.' },
  PreCompact: { supported: false, level: 'unsupported', reason: 'OpenCode has no verified pre-compaction runtime event.' },
  PostCompact: { supported: true, level: 'native', nativeEvent: 'session.compacted', reason: 'OpenCode exposes the session.compacted event.' },
  SubagentStart: { supported: false, level: 'unsupported', reason: 'OpenCode has no stable subagent-start runtime event.' },
  SubagentStop: { supported: false, level: 'unsupported', reason: 'OpenCode has no stable subagent-stop runtime event.' },
  Stop: { supported: true, level: 'degraded', nativeEvent: 'session.idle', reason: 'OpenCode session.idle is observable but cannot preserve all stop decisions.' },
});

/** Pi runtime Extension 对 11 个规范事件的固定映射。 */
const PI_EVENTS: Readonly<Record<string, HookEventSupport>> = Object.freeze({
  SessionStart: { supported: true, level: 'native', nativeEvent: 'session_start', reason: 'Pi exposes session_start.' },
  SessionEnd: { supported: true, level: 'native', nativeEvent: 'session_shutdown', reason: 'Pi exposes session_shutdown.' },
  UserPromptSubmit: { supported: true, level: 'native', nativeEvent: 'input', reason: 'Pi exposes the input event before agent processing.' },
  PreToolUse: { supported: true, level: 'native', nativeEvent: 'tool_call', reason: 'Pi tool_call can block tool execution.' },
  PermissionRequest: { supported: false, level: 'unsupported', reason: 'Pi has no distinct permission request event.' },
  PostToolUse: { supported: true, level: 'native', nativeEvent: 'tool_result', reason: 'Pi exposes tool_result.' },
  PreCompact: { supported: true, level: 'native', nativeEvent: 'session_before_compact', reason: 'Pi exposes session_before_compact.' },
  PostCompact: { supported: true, level: 'native', nativeEvent: 'session_compact', reason: 'Pi exposes session_compact.' },
  SubagentStart: { supported: false, level: 'unsupported', reason: 'Pi has no canonical subagent start event.' },
  SubagentStop: { supported: false, level: 'unsupported', reason: 'Pi has no canonical subagent stop event.' },
  Stop: { supported: true, level: 'degraded', nativeEvent: 'agent_end', reason: 'Pi agent_end is observable but cannot force every stop decision.' },
});

/** Claude Code 接受 matcher 字段、但会静默忽略 matcher 语义的事件。 */
const CLAUDE_MATCHER_IGNORED_EVENTS = new Set([
  'UserPromptSubmit',
  'PostToolBatch',
  'Stop',
  'TeammateIdle',
  'TaskCreated',
  'TaskCompleted',
  'WorktreeCreate',
  'WorktreeRemove',
  'MessageDisplay',
  'CwdChanged',
]);

/**
 * 判断 matcher 是否真正缩小了事件匹配范围。
 *
 * @param matcher 当前 Platform 解析后的 matcher。
 * @returns 非空且不是全匹配星号时返回 true。
 */
function hasMeaningfulMatcher(matcher: string | undefined): boolean {
  return matcher !== undefined && matcher !== '' && matcher !== '*';
}

/**
 * 判断一个规范或平台限定 Hook 是否应交给当前 Adapter。
 *
 * @param hook 已构建的 Hook。
 * @param platform 当前 Adapter 的 Platform ID。
 * @returns 规范事件或匹配的平台事件返回 true。
 */
function appliesToPlatform(hook: BundledHook, platform: string): boolean {
  /** 平台事件声明的可选目标 Platform。 */
  const eventPlatform = platformForEvent(hook.definition.event);
  return eventPlatform === undefined || eventPlatform === platform;
}

/**
 * 合并 Hook 顶层默认值和当前 Platform 的专属覆盖。
 *
 * @param hook 已通过 validate 的 Hook。
 * @param platform 当前 Adapter 的 Platform ID。
 * @returns 可直接生成平台 Handler 配置的只读值。
 */
function resolveOptions(hook: BundledHook, platform: string): ResolvedHookOptions {
  /** Hook 定义中当前 Platform 的已验证覆盖对象。 */
  const override = hook.definition.platforms?.[platform] as Readonly<Record<string, unknown>> | undefined;
  /** matcher 覆盖只在字段明确出现时替换顶层值。 */
  const matcher = typeof override?.matcher === 'string' ? override.matcher : hook.definition.matcher;
  /** timeout 覆盖只在字段明确出现时替换顶层值。 */
  const timeout = typeof override?.timeout === 'number' ? override.timeout : hook.definition.timeout;
  /** statusMessage 覆盖只在字段明确出现时替换顶层值。 */
  const statusMessage = typeof override?.statusMessage === 'string'
    ? override.statusMessage
    : hook.definition.statusMessage;
  /** additionalContextLimit 只属于 Codex Adapter Schema。 */
  const additionalContextLimit = typeof override?.additionalContextLimit === 'number'
    ? override.additionalContextLimit
    : undefined;
  return Object.freeze({
    ...(matcher === undefined ? {} : { matcher }),
    ...(timeout === undefined ? {} : { timeout }),
    ...(statusMessage === undefined ? {} : { statusMessage }),
    ...(additionalContextLimit === undefined ? {} : { additionalContextLimit }),
  });
}

/**
 * 创建 Claude Code 无 shell exec-form Handler。
 *
 * @param hook 当前已构建 Hook。
 * @param options 合并后的 Claude Code 选项。
 * @returns 只运行 Extension 生成 Bundle 的固定命令配置。
 */
function claudeCodeHandler(
  hook: BundledHook,
  options: ResolvedHookOptions,
): Readonly<Record<string, JsonValue>> {
  return Object.freeze({
    type: 'command',
    command: 'node',
    args: [`\${CLAUDE_PLUGIN_ROOT}/hooks/${hook.id}/handler.mjs`, CLAUDE_CODE_PLATFORM_ID],
    ...(options.timeout === undefined ? {} : { timeout: options.timeout }),
    ...(options.statusMessage === undefined ? {} : { statusMessage: options.statusMessage }),
  });
}

/**
 * 创建 Codex 当前公开字符串协议下的固定 Node Handler 命令。
 *
 * 作者不能提供命令内容；Hook ID 已通过 kebab-case 校验，因此该模板没有可注入片段。
 *
 * @param hook 当前已构建 Hook。
 * @param options 合并后的 Codex 选项。
 * @returns 只运行 Extension 生成 Bundle 的受控命令配置。
 */
function codexHandler(
  hook: BundledHook,
  options: ResolvedHookOptions,
): Readonly<Record<string, JsonValue>> {
  /** Codex 尚未公开 args 字段，因此使用固定且完整引用 Plugin Root 的命令模板。 */
  const command = `node "\${PLUGIN_ROOT}/hooks/${hook.id}/handler.mjs" ${CODEX_PLATFORM_ID}`;
  return Object.freeze({
    type: 'command',
    command,
    ...(options.timeout === undefined ? {} : { timeout: options.timeout }),
    ...(options.statusMessage === undefined ? {} : { statusMessage: options.statusMessage }),
    ...(options.additionalContextLimit === undefined
      ? {}
      : { additionalContextLimit: options.additionalContextLimit }),
  });
}

/**
 * 报告单个 Hook 在 Claude Code 上的实际能力结论。
 *
 * @param context 当前 Claude Code Adapter 上下文。
 * @param hook 正在适配的 Hook。
 */
function reportClaudeCompatibility(
  context: PlatformAdapterContext,
  hook: BundledHook,
  options: ResolvedHookOptions,
): void {
  /** 平台配置中实际使用的事件名称。 */
  const name = eventName(hook.definition.event);
  context.reportCompatibility({
    subject: `hook:${hook.id}`,
    capability: `event.${name}`,
    level: 'native',
    reason: `Claude Code supports local command handlers for ${name}.`,
  });
  if (hasMeaningfulMatcher(options.matcher) && CLAUDE_MATCHER_IGNORED_EVENTS.has(name)) {
    context.reportCompatibility({
      subject: `hook:${hook.id}`,
      capability: 'matcher',
      level: 'degraded',
      reason: `Claude Code currently ignores matcher for ${name}.`,
    });
  }
}

/**
 * 报告单个 Hook 在 Codex 上的事件能力和按实际字段计算的 matcher 损失。
 *
 * @param context 当前 Codex Adapter 上下文。
 * @param hook 正在适配的规范 Hook。
 * @param options 合并后的 Codex 选项。
 */
function reportCodexCompatibility(
  context: PlatformAdapterContext,
  hook: BundledHook,
  options: ResolvedHookOptions,
): void {
  /** 规范 Hook 的平台事件名称。 */
  const name = eventName(hook.definition.event);
  context.reportCompatibility({
    subject: `hook:${hook.id}`,
    capability: `event.${name}`,
    level: 'native',
    reason: `Codex supports local command handlers for ${name}.`,
  });
  if (hasMeaningfulMatcher(options.matcher) && (name === 'UserPromptSubmit' || name === 'Stop')) {
    context.reportCompatibility({
      subject: `hook:${hook.id}`,
      capability: 'matcher',
      level: 'degraded',
      reason: `Codex currently ignores matcher for ${name}.`,
    });
  }
}

/**
 * 把平台相关 Hook 组成确定性的 `hooks/hooks.json` 内容。
 *
 * @param platform 当前 Adapter Platform ID。
 * @param hooks 已筛选为当前平台适用的 Built Hook。
 * @returns 以事件名分组的官方 Hook 配置。
 */
function createHooksManifest(
  platform: typeof CLAUDE_CODE_PLATFORM_ID | typeof CODEX_PLATFORM_ID,
  hooks: readonly BundledHook[],
): Readonly<Record<string, JsonValue>> {
  /** 按事件名保存且随后由 stableJson 排序的 Handler 分组。 */
  const groups: Record<string, HookGroup[]> = {};
  for (const hook of hooks) {
    /** 当前 Adapter 解析后的 Hook 平台选项。 */
    const options = resolveOptions(hook, platform);
    /** 当前平台使用的受控 Handler 配置。 */
    const handler = platform === CLAUDE_CODE_PLATFORM_ID
      ? claudeCodeHandler(hook, options)
      : codexHandler(hook, options);
    /** 单 Handler matcher 分组，不依赖平台隐式数组合并。 */
    const group: HookGroup = Object.freeze({
      ...(options.matcher === undefined ? {} : { matcher: options.matcher }),
      hooks: Object.freeze([handler]),
    });
    /** 当前 Hook 的规范或平台原生事件名。 */
    const name = eventName(hook.definition.event);
    (groups[name] ??= []).push(group);
  }
  return Object.freeze({ hooks: groups as unknown as JsonValue });
}

/**
 * 向当前 Platform Draft 贡献 Handler、许可文件、Hook 清单和 Manifest 引用。
 *
 * @param context Core 提供的受限 Adapter API。
 * @param built Extension build 阶段产生的平台中立状态。
 * @param platform 当前官方 Adapter 的 Platform ID。
 */
async function applyAdapter(
  context: PlatformAdapterContext,
  built: Readonly<BuiltHooks>,
  platform: typeof CLAUDE_CODE_PLATFORM_ID | typeof CODEX_PLATFORM_ID,
): Promise<void> {
  /** 只保留规范事件和明确限定到当前 Platform 的事件。 */
  const hooks = built.hooks.filter(hook => appliesToPlatform(hook, platform));
  if (hooks.length === 0)
    return;
  /** Platform 必须提供约定的 Plugin Manifest Document 才能安全建立引用。 */
  const manifest = context.getDocument(PLUGIN_MANIFEST_ID);
  if (manifest === undefined) {
    context.reportDiagnostic({
      code: 'HOOK_PLATFORM_DOCUMENT_MISSING',
      severity: 'error',
      message: `Platform "${platform}" does not expose the required Plugin Manifest document.`,
    });
    return;
  }
  for (const hook of hooks) {
    context.emitArtifact({
      path: `hooks/${hook.id}/handler.mjs`,
      source: { type: 'file', path: hook.handler },
      mode: 0o755,
    });
    context.emitArtifact(bytesArtifact(
      `hooks/${hook.id}/wire.mjs`,
      createWireSource(platform),
      0o644,
    ));
    if (hook.licenses !== undefined) {
      context.emitArtifact({
        path: `hooks/${hook.id}/THIRD_PARTY_LICENSES.txt`,
        source: { type: 'file', path: hook.licenses },
        mode: 0o644,
      });
    }
    /** 当前 Platform 合并后的选项只用于精确兼容性计算。 */
    const options = resolveOptions(hook, platform);
    if (platform === CLAUDE_CODE_PLATFORM_ID)
      reportClaudeCompatibility(context, hook, options);
    else
      reportCodexCompatibility(context, hook, options);
  }
  context.emitArtifact(bytesArtifact(HOOKS_MANIFEST_PATH, stableJson(createHooksManifest(platform, hooks))));
  context.patchDocument({
    document: PLUGIN_MANIFEST_ID,
    path: ['hooks'],
    value: `./${HOOKS_MANIFEST_PATH}`,
  });
  void manifest;
}

/**
 * 读取非默认 Platform 的固定事件支持结论。
 *
 * @param platform 当前 Adapter Platform ID。
 * @param event 规范 Hook 事件名。
 * @returns 当前 Platform 的支持等级、原生事件和原因。
 */
function supportFor(
  platform: typeof CURSOR_PLATFORM_ID
    | typeof ANTIGRAVITY_PLATFORM_ID
    | typeof OPENCODE_PLATFORM_ID
    | typeof PI_PLATFORM_ID,
  event: string,
): HookEventSupport {
  /** 当前 Platform 对应的固定能力矩阵。 */
  const matrix = platform === CURSOR_PLATFORM_ID
    ? CURSOR_EVENTS
    : platform === ANTIGRAVITY_PLATFORM_ID
      ? ANTIGRAVITY_EVENTS
      : platform === OPENCODE_PLATFORM_ID
        ? OPENCODE_EVENTS
        : PI_EVENTS;
  return matrix[event] ?? {
    supported: false,
    level: 'unsupported',
    reason: `${platform} does not recognize Hook event ${event}.`,
  };
}

/**
 * 报告非默认 Platform 的事件、matcher 和展示字段兼容性。
 *
 * @param context 当前 Platform Adapter 上下文。
 * @param hook 正在适配的 Hook。
 * @param platform 当前 Adapter Platform ID。
 * @param support 当前事件固定支持结论。
 */
function reportPortableCompatibility(
  context: PlatformAdapterContext,
  hook: BundledHook,
  platform: typeof CURSOR_PLATFORM_ID
    | typeof ANTIGRAVITY_PLATFORM_ID
    | typeof OPENCODE_PLATFORM_ID
    | typeof PI_PLATFORM_ID,
  support: HookEventSupport,
): void {
  /** 规范 Hook 的事件名。 */
  const event = eventName(hook.definition.event);
  context.reportCompatibility({
    subject: `hook:${hook.id}`,
    capability: `event.${event}`,
    level: support.level,
    ...(support.nativeEvent === undefined ? {} : { transformation: support.nativeEvent }),
    reason: support.reason,
  });
  if (!support.supported)
    return;
  /** 当前 Platform 合并后的执行选项。 */
  const options = resolveOptions(hook, platform);
  if (hasMeaningfulMatcher(options.matcher)
    && event !== 'PreToolUse'
    && event !== 'PostToolUse'
    && event !== 'PermissionRequest') {
    context.reportCompatibility({
      subject: `hook:${hook.id}`,
      capability: 'matcher',
      level: 'degraded',
      reason: `${platform} cannot preserve this matcher outside a tool event.`,
    });
  }
  if (options.statusMessage !== undefined) {
    context.reportCompatibility({
      subject: `hook:${hook.id}`,
      capability: 'statusMessage',
      level: 'degraded',
      reason: `${platform} has no stable Hook status message field in the selected adapter protocol.`,
    });
  }
}

/**
 * 向当前 Platform 贡献一个已支持 Hook 的 Handler、wire 和第三方许可。
 *
 * @param context Core 提供的受限 Adapter API。
 * @param hook 当前已构建 Hook。
 * @param platform 当前 Adapter Platform ID。
 * @param root Handler 在交付单元中的固定根目录。
 */
function emitHookRuntime(
  context: PlatformAdapterContext,
  hook: BundledHook,
  platform: typeof CURSOR_PLATFORM_ID
    | typeof ANTIGRAVITY_PLATFORM_ID
    | typeof OPENCODE_PLATFORM_ID
    | typeof PI_PLATFORM_ID,
  root: string,
): void {
  context.emitArtifact({
    path: `${root}/${hook.id}/handler.mjs`,
    source: { type: 'file', path: hook.handler },
    mode: 0o755,
  });
  context.emitArtifact(bytesArtifact(
    `${root}/${hook.id}/wire.mjs`,
    createWireSource(platform),
    0o644,
  ));
  if (hook.licenses !== undefined) {
    context.emitArtifact({
      path: `${root}/${hook.id}/THIRD_PARTY_LICENSES.txt`,
      source: { type: 'file', path: hook.licenses },
      mode: 0o644,
    });
  }
}

/**
 * 应用 Cursor 静态 Plugin Hooks Adapter。
 *
 * @param context Core 提供的受限 Adapter API。
 * @param built Hooks Extension 的平台中立 Built State。
 */
async function applyCursorAdapter(
  context: PlatformAdapterContext,
  built: Readonly<BuiltHooks>,
): Promise<void> {
  /** Cursor Platform 必须开放 Plugin Manifest 的 hooks 扩展点。 */
  if (context.getDocument(PLUGIN_MANIFEST_ID) === undefined) {
    context.reportDiagnostic({
      code: 'HOOK_PLATFORM_DOCUMENT_MISSING', severity: 'error',
      message: 'Cursor Platform does not expose the required Plugin Manifest document.',
    });
    return;
  }
  /** Cursor 原生事件名到固定 command Handler 列表。 */
  const groups: Record<string, Readonly<Record<string, JsonValue>>[]> = {};
  for (const hook of built.hooks.filter(candidate => appliesToPlatform(candidate, CURSOR_PLATFORM_ID))) {
    /** 当前规范事件的固定 Cursor 支持结论。 */
    const support = supportFor(CURSOR_PLATFORM_ID, eventName(hook.definition.event));
    reportPortableCompatibility(context, hook, CURSOR_PLATFORM_ID, support);
    if (!support.supported || support.nativeEvent === undefined)
      continue;
    emitHookRuntime(context, hook, CURSOR_PLATFORM_ID, 'hooks');
    /** Cursor Hook 进程从官方 Plugin 根环境变量解析安装后 Handler。 */
    const command = `node "\${CURSOR_PLUGIN_ROOT}/hooks/${hook.id}/handler.mjs" cursor`;
    (groups[support.nativeEvent] ??= []).push(Object.freeze({ command }));
  }
  if (Object.keys(groups).length === 0)
    return;
  /** Cursor Plugin Hooks 使用 version 1 的事件到命令数组结构。 */
  context.emitArtifact(bytesArtifact('hooks/hooks.json', stableJson({ version: 1, hooks: groups })));
  context.patchDocument({ document: PLUGIN_MANIFEST_ID, path: ['hooks'], value: './hooks/hooks.json' });
}

/**
 * 应用 Antigravity 根 hooks.json Adapter。
 *
 * @param context Core 提供的受限 Adapter API。
 * @param built Hooks Extension 的平台中立 Built State。
 */
async function applyAntigravityAdapter(
  context: PlatformAdapterContext,
  built: Readonly<BuiltHooks>,
): Promise<void> {
  /** Antigravity 原生事件名到 matcher 分组。 */
  const groups: Record<string, HookGroup[]> = {};
  for (const hook of built.hooks.filter(candidate => appliesToPlatform(candidate, ANTIGRAVITY_PLATFORM_ID))) {
    /** 当前规范事件的固定 Antigravity 支持结论。 */
    const support = supportFor(ANTIGRAVITY_PLATFORM_ID, eventName(hook.definition.event));
    reportPortableCompatibility(context, hook, ANTIGRAVITY_PLATFORM_ID, support);
    if (!support.supported || support.nativeEvent === undefined)
      continue;
    emitHookRuntime(context, hook, ANTIGRAVITY_PLATFORM_ID, 'hooks');
    /** 当前 Platform 合并后的 matcher 配置。 */
    const options = resolveOptions(hook, ANTIGRAVITY_PLATFORM_ID);
    /** 安装后 Handler 只通过固定 Plugin 根变量运行。 */
    const handler = Object.freeze({
      type: 'command',
      command: `node "\${ANTIGRAVITY_PLUGIN_ROOT}/hooks/${hook.id}/handler.mjs" antigravity`,
    });
    (groups[support.nativeEvent] ??= []).push(Object.freeze({
      ...(options.matcher === undefined ? {} : { matcher: options.matcher }),
      hooks: Object.freeze([handler]),
    }));
  }
  if (Object.keys(groups).length > 0)
    context.emitArtifact(bytesArtifact('hooks.json', stableJson({ hooks: groups })));
}

/**
 * 应用 OpenCode runtime Plugin Adapter。
 *
 * @param context Core 提供的受限 Adapter API。
 * @param built Hooks Extension 的平台中立 Built State。
 */
async function applyOpenCodeAdapter(
  context: PlatformAdapterContext,
  built: Readonly<BuiltHooks>,
): Promise<void> {
  /** 实际进入 runtime Plugin 的已支持 Hook。 */
  const supported: BundledHook[] = [];
  for (const hook of built.hooks.filter(candidate => appliesToPlatform(candidate, OPENCODE_PLATFORM_ID))) {
    /** 当前规范事件的固定 OpenCode 支持结论。 */
    const support = supportFor(OPENCODE_PLATFORM_ID, eventName(hook.definition.event));
    reportPortableCompatibility(context, hook, OPENCODE_PLATFORM_ID, support);
    if (support.supported)
      supported.push(hook);
  }
  if (supported.length === 0)
    return;
  /** Runtime Plugin 读取的无函数静态 Hook 描述。 */
  const descriptors = supported.map((hook) => {
    /** 当前 Platform 合并后的 matcher 与 timeout。 */
    const options = resolveOptions(hook, OPENCODE_PLATFORM_ID);
    emitHookRuntime(context, hook, OPENCODE_PLATFORM_ID, '.opencode/acplugin-hooks');
    return runtimeHookDescriptor(hook, options.matcher, options.timeout);
  });
  context.emitArtifact(bytesArtifact(
    '.opencode/plugins/acplugin-hooks.mjs',
    createOpenCodePluginSource(descriptors),
  ));
}

/**
 * 应用 Pi npm package Extension Adapter。
 *
 * @param context Core 提供的受限 Adapter API。
 * @param built Hooks Extension 的平台中立 Built State。
 */
async function applyPiAdapter(
  context: PlatformAdapterContext,
  built: Readonly<BuiltHooks>,
): Promise<void> {
  /** Pi Platform 必须开放 package.json.pi.extensions 扩展点。 */
  if (context.getDocument('package-manifest') === undefined) {
    context.reportDiagnostic({
      code: 'HOOK_PLATFORM_DOCUMENT_MISSING', severity: 'error',
      message: 'Pi Platform does not expose the required package manifest document.',
    });
    return;
  }
  /** 实际进入 Pi Extension 的已支持 Hook。 */
  const supported: BundledHook[] = [];
  for (const hook of built.hooks.filter(candidate => appliesToPlatform(candidate, PI_PLATFORM_ID))) {
    /** 当前规范事件的固定 Pi 支持结论。 */
    const support = supportFor(PI_PLATFORM_ID, eventName(hook.definition.event));
    reportPortableCompatibility(context, hook, PI_PLATFORM_ID, support);
    if (support.supported)
      supported.push(hook);
  }
  if (supported.length === 0)
    return;
  /** Pi Extension 读取的无函数静态 Hook 描述。 */
  const descriptors = supported.map((hook) => {
    /** 当前 Platform 合并后的 matcher 与 timeout。 */
    const options = resolveOptions(hook, PI_PLATFORM_ID);
    emitHookRuntime(context, hook, PI_PLATFORM_ID, 'extensions/acplugin-hooks');
    return runtimeHookDescriptor(hook, options.matcher, options.timeout);
  });
  context.emitArtifact(bytesArtifact('extensions/acplugin-hooks.mjs', createPiExtensionSource(descriptors)));
  context.patchDocument({
    document: 'package-manifest',
    path: ['pi', 'extensions'],
    value: ['./extensions/acplugin-hooks.mjs'],
  });
}

/**
 * 创建 Hooks Extension 内置的六个平台 Adapter。
 *
 * @returns 只通过 Core 受限 API 写入平台 Draft 的固定 Adapter 列表。
 */
export function createHooksAdapters(): readonly ExtensionPlatformAdapter<BuiltHooks>[] {
  /** Claude Code 官方 Adapter。 */
  const claudeCode: ExtensionPlatformAdapter<BuiltHooks> = Object.freeze({
    extensionApiVersion: '1',
    platform: CLAUDE_CODE_PLATFORM_ID as PlatformId,
    platformApiVersion: '1',
    /** 把平台中立状态落为 Claude Code exec-form Hook 配置。 */
    apply: (context: PlatformAdapterContext, built: Readonly<BuiltHooks>) => applyAdapter(
      context,
      built,
      CLAUDE_CODE_PLATFORM_ID,
    ),
  });
  /** Codex 官方 Adapter。 */
  const codex: ExtensionPlatformAdapter<BuiltHooks> = Object.freeze({
    extensionApiVersion: '1',
    platform: CODEX_PLATFORM_ID as PlatformId,
    platformApiVersion: '1',
    /** 把平台中立状态落为 Codex 当前字符串命令 Hook 配置。 */
    apply: (context: PlatformAdapterContext, built: Readonly<BuiltHooks>) => applyAdapter(
      context,
      built,
      CODEX_PLATFORM_ID,
    ),
  });
  /** Cursor 官方 Adapter。 */
  const cursor: ExtensionPlatformAdapter<BuiltHooks> = Object.freeze({
    extensionApiVersion: '1',
    platform: CURSOR_PLATFORM_ID as PlatformId,
    platformApiVersion: '1',
    /** 把平台中立状态落为 Cursor version 1 command Hooks。 */
    apply: applyCursorAdapter,
  });
  /** Antigravity 官方 Adapter。 */
  const antigravity: ExtensionPlatformAdapter<BuiltHooks> = Object.freeze({
    extensionApiVersion: '1',
    platform: ANTIGRAVITY_PLATFORM_ID as PlatformId,
    platformApiVersion: '1',
    /** 把平台中立状态落为 Antigravity 根 hooks.json。 */
    apply: applyAntigravityAdapter,
  });
  /** OpenCode 官方 Adapter。 */
  const openCode: ExtensionPlatformAdapter<BuiltHooks> = Object.freeze({
    extensionApiVersion: '1',
    platform: OPENCODE_PLATFORM_ID as PlatformId,
    platformApiVersion: '1',
    /** 把平台中立状态落为 workspace runtime Plugin。 */
    apply: applyOpenCodeAdapter,
  });
  /** Pi 官方 Adapter。 */
  const pi: ExtensionPlatformAdapter<BuiltHooks> = Object.freeze({
    extensionApiVersion: '1',
    platform: PI_PLATFORM_ID as PlatformId,
    platformApiVersion: '1',
    /** 把平台中立状态落为 npm package Extension。 */
    apply: applyPiAdapter,
  });
  return Object.freeze([claudeCode, codex, cursor, antigravity, openCode, pi]);
}
