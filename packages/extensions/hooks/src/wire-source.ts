import {
  ANTIGRAVITY_PLATFORM_ID,
  CLAUDE_CODE_PLATFORM_ID,
  CODEX_PLATFORM_ID,
  CURSOR_PLATFORM_ID,
  OPENCODE_PLATFORM_ID,
  PI_PLATFORM_ID,
} from './constants.js';

/** Hooks Extension 当前内置 Contributor 的 Platform ID。 */
export type HookAdapterPlatform
  = | typeof CLAUDE_CODE_PLATFORM_ID
    | typeof CODEX_PLATFORM_ID
    | typeof CURSOR_PLATFORM_ID
    | typeof ANTIGRAVITY_PLATFORM_ID
    | typeof OPENCODE_PLATFORM_ID
    | typeof PI_PLATFORM_ID;

/**
 * 创建内联到平台中立 Handler 的官方 Hook wire profiles。
 *
 * profiles 负责原生 stdin 校验、camelCase 输入转换、运行目录解析和规范结果
 * 映射。它作为稳定虚拟模块进入同一个自包含 portable-node Bundle，因此运行时
 * 不依赖 Contributor 后续补写的 JavaScript 文件。
 *
 * @returns 可作为 Core Build Service 虚拟模块的 ESM 源码。
 */
export function createWireSource(): string {
  /** 每个平台只保存环境变量名称，任何环境值都留到 Plugin 真实运行时读取。 */
  const platformProfiles: Record<HookAdapterPlatform, readonly [string, string, string, string]> = {
    [CLAUDE_CODE_PLATFORM_ID]: ['CLAUDE_PLUGIN_ROOT', 'PLUGIN_ROOT', 'CLAUDE_PLUGIN_DATA', 'PLUGIN_DATA'],
    [CODEX_PLATFORM_ID]: ['PLUGIN_ROOT', 'CLAUDE_PLUGIN_ROOT', 'PLUGIN_DATA', 'CLAUDE_PLUGIN_DATA'],
    [CURSOR_PLATFORM_ID]: ['CURSOR_PLUGIN_ROOT', 'CLAUDE_PLUGIN_ROOT', 'PLUGIN_DATA', 'CLAUDE_PLUGIN_DATA'],
    [ANTIGRAVITY_PLATFORM_ID]: ['ANTIGRAVITY_PLUGIN_ROOT', 'CLAUDE_PLUGIN_ROOT', 'PLUGIN_DATA', 'CLAUDE_PLUGIN_DATA'],
    [OPENCODE_PLATFORM_ID]: ['PLUGIN_ROOT', 'CLAUDE_PLUGIN_ROOT', 'PLUGIN_DATA', 'CLAUDE_PLUGIN_DATA'],
    [PI_PLATFORM_ID]: ['PLUGIN_ROOT', 'CLAUDE_PLUGIN_ROOT', 'PLUGIN_DATA', 'CLAUDE_PLUGIN_DATA'],
  };
  return `
const PLATFORM_PROFILES = ${JSON.stringify(platformProfiles)};

export function contextFor(platform, environment) {
  const profile = PLATFORM_PROFILES[platform];
  if (!profile) throw new Error('PLATFORM_INVALID');
  return {
    pluginRoot: environment[profile[0]] || environment[profile[1]] || '',
    pluginData: environment[profile[2]] || environment[profile[3]] || '',
  };
}

const MAX_DEPTH = 128;
const EVENT_INPUTS = {
  SessionStart: { source: 'string' },
  SessionEnd: { reason: 'string' },
  UserPromptSubmit: { prompt: 'string' },
  PreToolUse: { tool_name: 'string', tool_input: 'present', tool_use_id: 'string' },
  PermissionRequest: { tool_name: 'string', tool_input: 'present' },
  PostToolUse: { tool_name: 'string', tool_input: 'present', tool_use_id: 'string', tool_response: 'present' },
  PreCompact: { trigger: 'string' },
  PostCompact: { trigger: 'string' },
  SubagentStart: { agent_id: 'string', agent_type: 'string' },
  SubagentStop: { agent_id: 'string', agent_type: 'string' },
  Stop: { stop_hook_active: 'boolean' },
};

function camel(key) {
  return key.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
}

function normalize(value, depth = 0) {
  if (depth > MAX_DEPTH) throw new Error('INPUT_TOO_DEEP');
  if (Array.isArray(value)) return value.map(child => normalize(child, depth + 1));
  if (value && typeof value === 'object') {
    const entries = [];
    const fields = new Set();
    for (const [key, child] of Object.entries(value)) {
      const field = camel(key);
      if (fields.has(field)) throw new Error('INPUT_KEY_COLLISION');
      fields.add(field);
      entries.push([field, normalize(child, depth + 1)]);
    }
    return Object.fromEntries(entries);
  }
  return value;
}

function validateInput(raw, expectedEvent) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('INPUT_OBJECT_REQUIRED');
  if (typeof raw.session_id !== 'string' || typeof raw.cwd !== 'string') throw new Error('INPUT_COMMON_INVALID');
  if (raw.transcript_path !== undefined && raw.transcript_path !== null && typeof raw.transcript_path !== 'string')
    throw new Error('INPUT_COMMON_INVALID');
  if (raw.hook_event_name !== expectedEvent) throw new Error('INPUT_EVENT_MISMATCH');
  const contract = EVENT_INPUTS[expectedEvent];
  if (!contract) return;
  for (const [field, type] of Object.entries(contract)) {
    if (type === 'present' ? !(field in raw) : typeof raw[field] !== type)
      throw new Error('INPUT_EVENT_INVALID');
  }
}

export function inputFor(platform, raw, expectedEvent, declaredEvent) {
  if (platform !== 'claude-code' && platform !== 'codex') {
    raw = {
      ...raw,
      session_id: raw.session_id ?? raw.sessionId ?? raw.conversation_id ?? '',
      cwd: raw.cwd ?? raw.workspaceRoot ?? '',
      hook_event_name: expectedEvent,
    };
    if (expectedEvent === 'SessionStart') raw.source ??= 'startup';
    if (expectedEvent === 'SessionEnd') raw.reason ??= 'complete';
    if (expectedEvent === 'UserPromptSubmit') raw.prompt ??= raw.message ?? raw.text ?? '';
    if (expectedEvent === 'PreToolUse' || expectedEvent === 'PostToolUse' || expectedEvent === 'PermissionRequest') {
      raw.tool_name ??= raw.toolName ?? raw.tool?.name ?? '';
      raw.tool_input ??= raw.toolInput ?? raw.input ?? raw.args ?? {};
      raw.tool_use_id ??= raw.toolUseId ?? raw.callId ?? '';
    }
    if (expectedEvent === 'PostToolUse') raw.tool_response ??= raw.toolResponse ?? raw.output ?? raw.result ?? null;
    if (expectedEvent === 'PreCompact' || expectedEvent === 'PostCompact') raw.trigger ??= raw.trigger ?? 'automatic';
    if (expectedEvent === 'SubagentStart' || expectedEvent === 'SubagentStop') {
      raw.agent_id ??= raw.agentId ?? '';
      raw.agent_type ??= raw.agentType ?? '';
    }
    if (expectedEvent === 'Stop') raw.stop_hook_active ??= raw.stopHookActive ?? false;
  }
  validateInput(raw, expectedEvent);
  const input = normalize(raw);
  input.event = declaredEvent;
  return input;
}

function addContext(output, event, additionalContext) {
  if (!additionalContext) return;
  output.hookSpecificOutput = { hookEventName: event, additionalContext };
}

export function outputFor(platform, event, result) {
  if (!result) return undefined;
  if (platform === 'opencode' || platform === 'pi') return { event, ...result };
  const output = {};
  if (result.systemMessage) output.systemMessage = result.systemMessage;
  if (event === 'PreToolUse') {
    if (result.decision === 'allow' || result.decision === 'deny') {
      output.hookSpecificOutput = {
        hookEventName: event,
        permissionDecision: result.decision,
        ...(result.reason ? { permissionDecisionReason: result.reason } : {}),
        ...(result.updatedInput === undefined ? {} : { updatedInput: result.updatedInput }),
        ...(result.additionalContext ? { additionalContext: result.additionalContext } : {}),
      };
    } else {
      addContext(output, event, result.additionalContext);
    }
  } else if (event === 'PermissionRequest') {
    if (result.decision === 'allow' || result.decision === 'deny') {
      output.hookSpecificOutput = {
        hookEventName: event,
        decision: {
          behavior: result.decision,
          ...(result.reason ? { message: result.reason } : {}),
        },
      };
    } else if (result.decision === 'defer' && result.reason && !output.systemMessage) {
      output.systemMessage = result.reason;
    }
  } else if (event === 'PostToolUse') {
    if (result.decision === 'block') {
      output.decision = 'block';
      output.reason = result.reason || 'Blocked by hook.';
    }
    addContext(output, event, result.additionalContext);
  } else if (event === 'UserPromptSubmit') {
    if (result.decision === 'deny') {
      output.decision = 'block';
      output.reason = result.reason || 'Blocked by hook.';
    }
    addContext(output, event, result.additionalContext);
  } else if (event === 'Stop' || event === 'SubagentStop') {
    if (result.decision === 'continue') {
      output.decision = 'block';
      output.reason = result.reason || 'Continue before stopping.';
    }
  } else if (event === 'SessionStart') {
    if (result.decision === 'stop') {
      output.continue = false;
      output.stopReason = result.reason || 'Stopped by hook.';
    }
    addContext(output, event, result.additionalContext);
  } else if (event === 'PreCompact' && result.decision === 'stop') {
    if (platform === 'claude-code') {
      output.decision = 'block';
      output.reason = result.reason || 'Compaction stopped by hook.';
    } else {
      output.continue = false;
      output.stopReason = result.reason || 'Compaction stopped by hook.';
    }
  } else if (event === 'PostCompact' && result.decision === 'stop') {
    output.continue = false;
    output.stopReason = result.reason || 'Compaction stopped by hook.';
  } else if (event === 'SubagentStart') {
    addContext(output, event, result.additionalContext);
  }
  return Object.keys(output).length ? output : undefined;
}
`;
}
