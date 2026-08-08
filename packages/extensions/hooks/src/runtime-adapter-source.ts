import type { BundledHook } from './bundler.js';
import { eventName } from './discovery.js';

/** 运行时 Platform Plugin 需要的单个 Hook 静态描述。 */
interface RuntimeHookDescriptor {
  /** 规范 Hook ID。 */
  readonly id: string;
  /** 规范事件名。 */
  readonly event: string;
  /** 工具事件使用的可选正则 matcher。 */
  readonly matcher?: string;
  /** 子进程超时毫秒数。 */
  readonly timeout: number;
}

/**
 * 把 Built Hook 转换为不含函数和源码路径的运行时描述。
 *
 * @param hook 已完成平台中立 Bundle 的 Hook。
 * @param matcher 当前 Platform 合并后的 matcher。
 * @param timeout 当前 Platform 合并后的超时秒数。
 * @returns 可安全嵌入生成运行时代码的静态 JSON 数据。
 */
export function runtimeHookDescriptor(
  hook: BundledHook,
  matcher: string | undefined,
  timeout: number | undefined,
): RuntimeHookDescriptor {
  return Object.freeze({
    id: hook.id,
    event: eventName(hook.definition.event),
    ...(matcher === undefined ? {} : { matcher }),
    timeout: Math.max(1, Math.round((timeout ?? 30) * 1_000)),
  });
}

/**
 * 创建 OpenCode runtime Plugin 源码。
 *
 * 生成代码只依赖 Node 内置模块，通过子进程运行同一平台中立 Handler；Plugin
 * 自身负责把 OpenCode callback 输入规范化，并把决策应用回 callback output。
 *
 * @param hooks 已筛选为 OpenCode 支持事件的静态描述。
 * @returns 可直接放入 `.opencode/plugins` 的 ESM 源码。
 */
export function createOpenCodePluginSource(hooks: readonly RuntimeHookDescriptor[]): string {
  return `
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const hooks = ${JSON.stringify(hooks)};
const pluginFile = fileURLToPath(import.meta.url);
const workspaceRoot = path.resolve(path.dirname(pluginFile), '../..');

function matches(hook, input) {
  if (!hook.matcher || hook.matcher === '*') return true;
  const subject = input.tool_name || input.toolName || input.tool?.name || '';
  return new RegExp(hook.matcher).test(subject);
}

function execute(hook, input) {
  return new Promise((resolve, reject) => {
    const handler = path.join(workspaceRoot, '.opencode', 'acplugin-hooks', hook.id, 'handler.mjs');
    const child = spawn(process.execPath, [handler, 'opencode'], {
      cwd: workspaceRoot,
      env: { ...process.env, PLUGIN_ROOT: workspaceRoot, PLUGIN_DATA: path.join(workspaceRoot, '.opencode', 'data') },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), hook.timeout);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error('acplugin Hook failed.'));
      else resolve(stdout.trim() ? JSON.parse(stdout) : undefined);
    });
    child.stdin.end(JSON.stringify({ session_id: '', cwd: workspaceRoot, hook_event_name: hook.event, ...input }));
  });
}

async function run(event, input, output) {
  for (const hook of hooks.filter(candidate => candidate.event === event && matches(candidate, input))) {
    const result = await execute(hook, input);
    if (!result) continue;
    if (result.updatedInput && output && typeof output === 'object') output.args = result.updatedInput;
    if (result.additionalContext && output && Array.isArray(output.parts))
      output.parts.push({ type: 'text', text: result.additionalContext, synthetic: true });
    if (result.decision === 'deny' || result.decision === 'block' || result.decision === 'continue')
      throw new Error(result.reason || 'Blocked by acplugin Hook.');
  }
}

export default async function acpluginHooks() {
  return {
    'chat.message': (input, output) => run('UserPromptSubmit', { ...input, prompt: input.prompt || input.message || '' }, output),
    'tool.execute.before': (input, output) => run('PreToolUse', input, output),
    'tool.execute.after': (input, output) => run('PostToolUse', input, output),
    event: async ({ event }) => {
      const mapping = {
        'session.created': 'SessionStart',
        'session.deleted': 'SessionEnd',
        'session.compacted': 'PostCompact',
        'session.idle': 'Stop',
      };
      const canonical = mapping[event?.type];
      if (canonical) await run(canonical, event, undefined);
    },
  };
}
`;
}

/**
 * 创建 Pi Extension 源码。
 *
 * @param hooks 已筛选为 Pi 支持事件的静态描述。
 * @returns 默认导出 Pi Extension 工厂的 Node ESM 源码。
 */
export function createPiExtensionSource(hooks: readonly RuntimeHookDescriptor[]): string {
  return `
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const hooks = ${JSON.stringify(hooks)};
const extensionFile = fileURLToPath(import.meta.url);
const packageRoot = path.resolve(path.dirname(extensionFile), '..');
const events = {
  SessionStart: 'session_start',
  SessionEnd: 'session_shutdown',
  UserPromptSubmit: 'input',
  PreToolUse: 'tool_call',
  PostToolUse: 'tool_result',
  PreCompact: 'session_before_compact',
  PostCompact: 'session_compact',
  Stop: 'agent_end',
};

function matches(hook, input) {
  if (!hook.matcher || hook.matcher === '*') return true;
  const subject = input.tool_name || input.toolName || input.tool?.name || '';
  return new RegExp(hook.matcher).test(subject);
}

function execute(hook, input) {
  return new Promise((resolve, reject) => {
    const handler = path.join(packageRoot, 'extensions', 'acplugin-hooks', hook.id, 'handler.mjs');
    const child = spawn(process.execPath, [handler, 'pi'], {
      cwd: packageRoot,
      env: { ...process.env, PLUGIN_ROOT: packageRoot, PLUGIN_DATA: path.join(packageRoot, '.pi-data') },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), hook.timeout);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error('acplugin Hook failed.'));
      else resolve(stdout.trim() ? JSON.parse(stdout) : undefined);
    });
    child.stdin.end(JSON.stringify({ session_id: '', cwd: packageRoot, hook_event_name: hook.event, ...input }));
  });
}

export default function acpluginHooks(pi) {
  for (const hook of hooks) {
    const nativeEvent = events[hook.event];
    if (!nativeEvent) continue;
    pi.on(nativeEvent, async (event, context) => {
      const input = { ...event, cwd: context?.cwd || packageRoot };
      if (!matches(hook, input)) return undefined;
      const result = await execute(hook, input);
      if (!result) return undefined;
      if (hook.event === 'PreToolUse' && result.decision === 'deny')
        return { block: true, reason: result.reason || 'Blocked by acplugin Hook.' };
      if (hook.event === 'UserPromptSubmit' && result.decision === 'deny')
        return { action: 'handled' };
      return undefined;
    });
  }
}
`;
}
