import type { JsonValue } from '@tokenroll/acplugin/sdk';

/** acplugin 1.0 在所有官方 Contributor 之间保持稳定语义的 Hook 事件。 */
export const HOOK_EVENTS = [
  'SessionStart',
  'SessionEnd',
  'UserPromptSubmit',
  'PreToolUse',
  'PermissionRequest',
  'PostToolUse',
  'PreCompact',
  'PostCompact',
  'SubagentStart',
  'SubagentStop',
  'Stop',
] as const;

/** Claude Code 当前公开、但不进入 acplugin 规范事件联合类型的专属事件。 */
export const CLAUDE_CODE_PLATFORM_EVENTS = [
  'Setup',
  'UserPromptExpansion',
  'PermissionDenied',
  'PostToolUseFailure',
  'PostToolBatch',
  'Notification',
  'MessageDisplay',
  'TaskCreated',
  'TaskCompleted',
  'StopFailure',
  'TeammateIdle',
  'InstructionsLoaded',
  'ConfigChange',
  'CwdChanged',
  'DirectoryAdded',
  'FileChanged',
  'WorktreeCreate',
  'WorktreeRemove',
  'Elicitation',
  'ElicitationResult',
] as const;

/** 规范 Hook 事件名称联合类型。 */
export type HookEvent = typeof HOOK_EVENTS[number];

/** 当前 Claude Code Contributor 能识别的平台专属事件名称。 */
export type ClaudeCodePlatformHookEvent = typeof CLAUDE_CODE_PLATFORM_EVENTS[number];

/** 把非规范事件显式限定到一个 Platform，避免悄然污染可移植事件集合。 */
export interface PlatformHookEvent {
  /** 唯一接收该事件的 Platform ID。 */
  readonly platform: string;
  /** 由对应 Contributor Schema 识别的平台原生事件名。 */
  readonly name: string;
}

/** Hook 作者可以声明的规范事件或显式平台限定事件。 */
export type HookEventDeclaration = HookEvent | PlatformHookEvent;

/** 所有 Hook 输入共享的 camelCase 会话字段。 */
export interface HookInputBase<Event extends HookEventDeclaration = HookEventDeclaration> {
  /** 当前定义声明的规范事件或平台限定事件。 */
  readonly event: Event;
  /** 当前 AI 平台会话 ID。 */
  readonly sessionId: string;
  /** 平台提供时的会话记录文件路径。 */
  readonly transcriptPath?: string | null;
  /** Hook 触发时的工作目录。 */
  readonly cwd: string;
  /** 平台提供时的权限模式。 */
  readonly permissionMode?: string;
  /** 保留经过递归 camelCase 规范化的平台扩展字段。 */
  readonly [field: string]: unknown;
}

/** 每个规范事件在共享字段之外保证提供的 camelCase 输入。 */
export interface HookInputByEvent {
  /** 会话开始原因。 */
  readonly SessionStart: { readonly source: string };
  /** 会话结束原因。 */
  readonly SessionEnd: { readonly reason: string };
  /** 即将提交给模型的用户提示。 */
  readonly UserPromptSubmit: { readonly prompt: string };
  /** 工具调用执行前的名称、输入和调用 ID。 */
  readonly PreToolUse: {
    readonly toolName: string;
    readonly toolInput: unknown;
    readonly toolUseId: string;
  };
  /** 即将进入平台审批流程的工具调用。 */
  readonly PermissionRequest: {
    readonly toolName: string;
    readonly toolInput: unknown;
    readonly toolUseId?: string;
  };
  /** 已完成工具调用的输入和平台结果。 */
  readonly PostToolUse: {
    readonly toolName: string;
    readonly toolInput: unknown;
    readonly toolUseId: string;
    readonly toolResponse: unknown;
  };
  /** 压缩前的触发原因和可选自定义指令。 */
  readonly PreCompact: {
    readonly trigger: string;
    readonly customInstructions?: string | null;
  };
  /** 压缩完成后的触发原因。 */
  readonly PostCompact: { readonly trigger: string };
  /** 新启动子代理的身份和类型。 */
  readonly SubagentStart: {
    readonly agentId: string;
    readonly agentType: string;
  };
  /** 准备停止子代理时的平台状态。 */
  readonly SubagentStop: {
    readonly agentId: string;
    readonly agentType: string;
    readonly stopHookActive?: boolean;
    readonly lastAssistantMessage?: string | null;
  };
  /** 主流程准备停止时的平台状态。 */
  readonly Stop: {
    readonly stopHookActive: boolean;
    readonly lastAssistantMessage?: string | null;
  };
}

/** 根据事件声明选择精确的规范输入；平台事件保留共享和扩展字段。 */
export type HookInput<Event extends HookEventDeclaration = HookEventDeclaration>
  = HookInputBase<Event>
    & (Event extends HookEvent ? HookInputByEvent[Event] : Readonly<Record<string, unknown>>);

/** 由生成的 Handler 提供给用户实现的只读运行时上下文。 */
export interface HookRuntimeContext {
  /** 当前实际触发 Handler 的 Platform。 */
  readonly platform: string;
  /** 已安装 Plugin 的只读根目录。 */
  readonly pluginRoot: string;
  /** 平台为 Plugin 提供的可写持久数据目录。 */
  readonly pluginData: string;
}

/** 只向平台或用户界面提供提示、不改变控制流的结果。 */
export interface HookAdvisoryResult {
  /** 平台支持时显示的系统级消息。 */
  readonly systemMessage?: string;
}

/** 可以向模型会话追加上下文的结果。 */
export interface HookContextResult extends HookAdvisoryResult {
  /** 追加到当前模型上下文的文本。 */
  readonly additionalContext?: string;
}

/** 携带决策和可选解释的规范结果。 */
export interface HookDecisionResult<Decision extends string> extends HookAdvisoryResult {
  /** 当前事件允许的规范决策值。 */
  readonly decision?: Decision;
  /** 随决策提供给平台的安全解释。 */
  readonly reason?: string;
}

/** 控制生命周期继续或停止的规范结果。 */
export interface HookFlowResult<Decision extends string> extends HookAdvisoryResult {
  /** 当前流程允许的规范决策值。 */
  readonly decision?: Decision;
  /** 平台支持时用于说明停止或继续原因的文本。 */
  readonly reason?: string;
}

/** 每个规范事件允许返回的精确 camelCase 结果。 */
export interface HookResultByEvent {
  /** 会话开始时可以追加上下文或停止当前流程。 */
  readonly SessionStart: HookContextResult & HookFlowResult<'continue' | 'stop'>;
  /** 会话结束结果只提供 advisory 信息。 */
  readonly SessionEnd: HookAdvisoryResult;
  /** 用户提示提交前可以拒绝提示或追加上下文。 */
  readonly UserPromptSubmit: HookContextResult & HookDecisionResult<'allow' | 'deny'>;
  /** 工具执行前可以决策、替换输入并追加上下文。 */
  readonly PreToolUse: HookContextResult & HookDecisionResult<'allow' | 'deny'> & {
    readonly updatedInput?: JsonValue;
  };
  /** 权限请求可以直接允许、拒绝或交回平台处理。 */
  readonly PermissionRequest: HookDecisionResult<'allow' | 'deny' | 'defer'>;
  /** 工具执行后可以放行或把反馈作为阻断结果。 */
  readonly PostToolUse: HookContextResult & HookDecisionResult<'pass' | 'block'>;
  /** 压缩前可以继续或停止压缩。 */
  readonly PreCompact: HookFlowResult<'continue' | 'stop'>;
  /** 压缩后可以继续或停止后续流程。 */
  readonly PostCompact: HookFlowResult<'continue' | 'stop'>;
  /** 子代理开始时可以追加上下文。 */
  readonly SubagentStart: HookContextResult;
  /** 子代理结束前可以完成或要求继续。 */
  readonly SubagentStop: HookDecisionResult<'finish' | 'continue'>;
  /** 主流程结束前可以完成或要求继续。 */
  readonly Stop: HookDecisionResult<'finish' | 'continue'>;
}

/** 根据事件选择结果类型；平台专属事件首期只开放 advisory 输出。 */
export type HookResult<Event extends HookEventDeclaration = HookEventDeclaration>
  = void | (Event extends HookEvent ? HookResultByEvent[Event] : HookAdvisoryResult);

/** Claude Code Contributor 允许覆盖的单 Hook 平台字段。 */
export interface ClaudeCodeHookOptions {
  /** 覆盖当前 Hook 的 Claude Code matcher。 */
  readonly matcher?: string;
  /** 覆盖当前 Hook 的 Claude Code 超时秒数。 */
  readonly timeout?: number;
  /** 覆盖 Hook 执行期间显示的状态消息。 */
  readonly statusMessage?: string;
}

/** Codex Contributor 允许覆盖的单 Hook 平台字段。 */
export interface CodexHookOptions extends ClaudeCodeHookOptions {
  /** 调整 Codex 在溢写前直接注入模型的上下文 Token 上限。 */
  readonly additionalContextLimit?: number;
}

/** Cursor、Antigravity、OpenCode 与 Pi Contributor 共享的受控执行选项。 */
export interface PortableHookOptions {
  /** 覆盖当前 Hook 的工具或事件匹配表达式。 */
  readonly matcher?: string;
  /** 覆盖 Handler 的超时秒数。 */
  readonly timeout?: number;
  /** 平台支持时显示的 Handler 状态消息。 */
  readonly statusMessage?: string;
}

/** Hook 的平台专属补充字段；已知 Platform 获得精确类型，其他键由 Contributor 验证。 */
export type HookPlatformOptions = Readonly<{
  readonly 'claude-code'?: ClaudeCodeHookOptions;
  readonly 'codex'?: CodexHookOptions;
  readonly 'cursor'?: PortableHookOptions;
  readonly 'antigravity'?: PortableHookOptions;
  readonly 'opencode'?: PortableHookOptions;
  readonly 'pi'?: PortableHookOptions;
}> & Readonly<Record<string, unknown>>;

/** 单个 `src/hooks/<id>/hook.ts` 默认导出的完整 Hook 契约。 */
export interface Hook<Event extends HookEventDeclaration = HookEventDeclaration> {
  /** 需要订阅的规范事件或显式平台限定事件。 */
  readonly event: Event;
  /** 所有 Contributor 默认继承的匹配表达式。 */
  readonly matcher?: string;
  /** 所有 Contributor 默认继承的 Handler 超时秒数。 */
  readonly timeout?: number;
  /** 平台支持时显示的 Handler 状态消息。 */
  readonly statusMessage?: string;
  /** 按 Platform ID 补充且由对应 Contributor Schema 验证的字段。 */
  readonly platforms?: HookPlatformOptions;
  /** 处理 camelCase 输入并返回对应事件的规范结果。 */
  readonly run: (
    input: HookInput<Event>,
    context: HookRuntimeContext,
  ) => HookResult<Event> | Promise<HookResult<Event>>;
}
