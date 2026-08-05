import { promises as fs } from 'node:fs';
import path from 'node:path';
import { build as rolldownBuild, type OutputChunk } from 'rolldown';
import {
  bytesArtifact,
  stableJson,
  type AcpluginModule,
  type CompatibilityEntry,
  type ModuleBuildContext,
  type ModuleDiscoverContext,
  type ModuleGenerateContext,
  type ModuleValidateContext,
  type TargetContribution,
  type TargetId,
} from '@tokenroll/acplugin';

/** Hooks 官方 Module 的稳定名称，也是诊断和配置依赖使用的唯一 ID。 */
export const HOOKS_MODULE_NAME = '@tokenroll/acplugin-module-hooks';

/** Claude Code 与 Codex 当前都可通过本地命令 Handler 表达的 Hook 事件。 */
export const PORTABLE_HOOK_EVENTS = [
  'SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PreToolUse',
  'PermissionRequest', 'PostToolUse', 'PreCompact', 'PostCompact',
  'SubagentStart', 'SubagentStop', 'Stop',
] as const;

/** 当前只能为 Claude Code 生成、在 Codex 目标上报告不支持的 Hook 事件。 */
export const CLAUDE_ONLY_HOOK_EVENTS = [
  'Setup', 'UserPromptExpansion', 'PermissionDenied', 'PostToolUseFailure',
  'PostToolBatch', 'Notification', 'MessageDisplay', 'TaskCreated', 'TaskCompleted',
  'StopFailure', 'TeammateIdle', 'InstructionsLoaded', 'ConfigChange', 'CwdChanged',
  'DirectoryAdded', 'FileChanged', 'WorktreeCreate', 'WorktreeRemove',
  'Elicitation', 'ElicitationResult',
] as const;

/** 两个内置目标均支持的 Hook 事件联合类型。 */
export type PortableHookEvent = typeof PORTABLE_HOOK_EVENTS[number];
/** 仅 Claude Code 支持的 Hook 事件联合类型。 */
export type ClaudeOnlyHookEvent = typeof CLAUDE_ONLY_HOOK_EVENTS[number];
/** acplugin Hooks Module 接受的全部 Hook 事件。 */
export type HookEvent = PortableHookEvent | ClaudeOnlyHookEvent;

/** 传递给 Hook 实现的规范化事件输入，并保留平台额外字段。 */
export interface HookInput<Event extends HookEvent = HookEvent> {
  /** 已从平台字段规范化的 Hook 事件名。 */
  event: Event;
  /** 当前 AI 平台会话 ID。 */
  sessionId: string;
  /** 平台提供时的会话记录文件路径。 */
  transcriptPath?: string | null;
  /** Hook 触发时的工作目录。 */
  cwd: string;
  /** 平台或事件特有、经过 snake_case 转 camelCase 的额外输入。 */
  [field: string]: unknown;
}

/** 由生成的运行器提供给 Hook 实现的跨平台运行时上下文。 */
export interface HookRuntimeContext {
  /** 当前实际运行的目标平台。 */
  target: TargetId;
  /** 已安装 Plugin 的根目录。 */
  pluginRoot: string;
  /** 平台提供的 Plugin 可写数据目录。 */
  pluginData: string;
}

/** 只允许向平台附加系统消息、不改变流程的 Hook 结果。 */
interface AdvisoryResult {
  /** 平台支持时展示或注入的系统级提示。 */
  systemMessage?: string;
}

/** 可向当前模型上下文追加文本的 Hook 结果。 */
interface ContextResult extends AdvisoryResult {
  /** 注入当前会话或调用上下文的补充信息。 */
  additionalContext?: string;
}

/** 带可选原因的事件决策结果。 */
interface DecisionResult<Decision extends string> extends AdvisoryResult {
  /** 当前事件允许的规范决策值。 */
  decision?: Decision;
  /** 平台支持时随决策返回的解释。 */
  reason?: string;
}

/** 不携带 reason、只控制生命周期流转的 Hook 结果。 */
interface FlowResult<Decision extends string> extends AdvisoryResult {
  /** 当前流程事件允许的规范决策值。 */
  decision?: Decision;
}

/** 为每个可移植 Hook 事件定义精确的结果字段和决策联合类型。 */
export interface HookResultByEvent {
  /** 会话开始时可追加上下文或停止继续。 */
  SessionStart: ContextResult & FlowResult<'continue' | 'stop'>;
  /** 会话结束只允许返回提示信息。 */
  SessionEnd: AdvisoryResult;
  /** 用户提示提交前可追加上下文或拒绝提示。 */
  UserPromptSubmit: ContextResult & DecisionResult<'allow' | 'deny'>;
  /** 工具使用前可决策、修改输入并追加上下文。 */
  PreToolUse: ContextResult & DecisionResult<'allow' | 'deny'> & { updatedInput?: unknown };
  /** 权限请求可允许、拒绝或交回平台默认处理。 */
  PermissionRequest: DecisionResult<'allow' | 'deny' | 'defer'>;
  /** 工具使用后可放行或阻断，并追加上下文。 */
  PostToolUse: ContextResult & DecisionResult<'pass' | 'block'>;
  /** 压缩前可继续或停止流程。 */
  PreCompact: FlowResult<'continue' | 'stop'>;
  /** 压缩后可继续或停止流程。 */
  PostCompact: FlowResult<'continue' | 'stop'>;
  /** 子代理启动时可追加上下文。 */
  SubagentStart: ContextResult;
  /** 子代理准备停止时可结束或要求继续。 */
  SubagentStop: DecisionResult<'finish' | 'continue'>;
  /** 主流程准备停止时可结束或要求继续。 */
  Stop: DecisionResult<'finish' | 'continue'>;
}

/** 根据事件类型选择精确结果；平台专有事件只允许 AdvisoryResult。 */
export type HookResult<Event extends HookEvent = HookEvent>
  = void
    | (Event extends keyof HookResultByEvent ? HookResultByEvent[Event] : AdvisoryResult);

/** 单个 `src/hooks/<id>/hook.ts` 默认导出的完整 Hook 契约。 */
export interface HookDefinition<Event extends HookEvent = HookEvent> {
  /** 由 defineHook 注入、供 discover 阶段验证来源的品牌字段。 */
  readonly __acpluginHook: true;
  /** 需要订阅的 Hook 事件。 */
  event: Event;
  /** 可选的平台匹配表达式；必须是有效正则字符串。 */
  matcher?: string;
  /** 可选的 Handler 超时秒数。 */
  timeout?: number;
  /** 平台支持时在 Hook 运行期间显示的状态文本。 */
  statusMessage?: string;
  /**
   * 处理规范化输入并返回与事件对应的结果。
   *
   * @param input 事件输入和平台额外字段。
   * @param context 当前安装目标与 Plugin 目录上下文。
   */
  run(input: HookInput<Event>, context: HookRuntimeContext): HookResult<Event> | Promise<HookResult<Event>>;
}

/** 配置作者需要提供的 Hook 字段，不包含框架品牌字段。 */
export type HookDefinitionInput<Event extends HookEvent = HookEvent> = Omit<HookDefinition<Event>, '__acpluginHook'>;

/**
 * 为 Hook 定义提供类型推断，并注入 discover 阶段使用的不可变品牌字段。
 *
 * @param definition 配置作者提供的事件、匹配和 Handler。
 * @returns 冻结后的完整 HookDefinition。
 */
export function defineHook<Event extends HookEvent>(definition: HookDefinitionInput<Event>): HookDefinition<Event> {
  return Object.freeze({ ...definition, __acpluginHook: true });
}

/** discover 阶段保存的 Hook 描述、目录与已执行定义。 */
interface DiscoveredHook {
  /** 从一级目录名称取得的 Hook ID。 */
  id: string;
  /** 当前 Hook 的绝对源码目录。 */
  directory: string;
  /** `hook.ts` 的绝对路径。 */
  sourcePath: string;
  /** TypeScript 描述文件执行后得到的 Hook 定义。 */
  definition: HookDefinition;
}

/** build 阶段向 generate 阶段传递的按 Hook、Target 索引 Bundle。 */
interface BuiltHooksState {
  /** 每个 Hook 对各支持目标生成的运行器。 */
  bundles: ReadonlyMap<string, ReadonlyMap<TargetId, BundledHook>>;
}

/** 单个 Hook 针对单个目标构建的可执行 Handler 与许可文件。 */
interface BundledHook {
  /** Rolldown 生成的独立 ESM Handler 路径。 */
  handler: string;
  /** Bundle 包含第三方依赖时生成的合并许可文件。 */
  licenses?: string;
}

/** Hook 一级目录接受的小写 kebab-case 格式。 */
const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** 用于运行时配置验证的全部已知 Hook 事件集合。 */
const ALL_EVENTS = new Set<HookEvent>([...PORTABLE_HOOK_EVENTS, ...CLAUDE_ONLY_HOOK_EVENTS]);

/**
 * 兼容 Jiti 可能返回的模块命名空间或已解包默认导出。
 *
 * @param value TypeScript Module 加载结果。
 * @returns 存在 default 时返回 default，否则返回原值。
 */
function unwrapDefault(value: unknown): unknown {
  if (value && typeof value === 'object' && 'default' in value)
    return (value as { default: unknown }).default;
  return value;
}

/** Bundle 中一个第三方 npm 包的许可元数据与原始 Notice 文本。 */
interface PackageLicense {
  /** npm 包名。 */
  name: string;
  /** npm 包版本。 */
  version: string;
  /** package.json 声明的 SPDX 标识或 UNKNOWN。 */
  license: string;
  /** 包根目录中发现的 LICENSE/NOTICE 文件。 */
  notices: readonly { name: string; text: string }[];
}

/**
 * 从 Rolldown Module ID 向上查找所属 npm 包及其许可文件。
 *
 * @param moduleId Bundle 图中的原始 Module ID。
 * @returns 第三方 node_modules 文件对应的许可记录；工程源码返回 undefined。
 * @throws 第三方包缺少元数据或许可文件时抛出异常，阻止发布不完整 Bundle。
 */
async function packageLicenseForModule(moduleId: string): Promise<PackageLicense | undefined> {
  /** 移除 Rolldown 查询参数和虚拟模块前缀后的文件路径。 */
  const normalized = moduleId.replace(/\?.*$/, '').replace(/^\0/, '');
  if (!normalized.includes(`${path.sep}node_modules${path.sep}`))
    return undefined;
  /** 从模块文件开始向上查找 package.json 的当前目录。 */
  let directory = path.dirname(normalized);
  /** 终止向上遍历的文件系统根目录。 */
  const root = path.parse(directory).root;
  while (directory !== root) {
    try {
      /** 当前候选目录中的包清单。 */
      const manifest = JSON.parse(await fs.readFile(path.join(directory, 'package.json'), 'utf8')) as {
        name?: unknown;
        version?: unknown;
        license?: unknown;
      };
      if (typeof manifest.name === 'string' && typeof manifest.version === 'string') {
        /** 包根目录的一级文件，用于发现法律文本。 */
        const entries = await fs.readdir(directory, { withFileTypes: true });
        /** 按稳定顺序保留的 LICENSE 与 NOTICE 文件名。 */
        const noticeFiles = entries
          .filter(entry => entry.isFile() && /^(?:licen[cs]e|notice)(?:\..*)?$/i.test(entry.name))
          .map(entry => entry.name)
          .sort((a, b) => a.localeCompare(b, 'en'));
        if (noticeFiles.length === 0)
          throw new Error(`Bundled dependency ${manifest.name}@${manifest.version} has no license or notice file.`);
        return {
          name: manifest.name,
          version: manifest.version,
          license: typeof manifest.license === 'string' ? manifest.license : 'UNKNOWN',
          notices: await Promise.all(noticeFiles.map(async name => ({
            name,
            text: (await fs.readFile(path.join(directory, name), 'utf8')).trimEnd(),
          }))),
        };
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        throw error;
    }
    directory = path.dirname(directory);
  }
  throw new Error(`Cannot resolve package metadata for bundled module ${path.basename(normalized)}.`);
}

/**
 * 汇总 Bundle 实际包含的第三方包许可，并写入稳定文本文件。
 *
 * @param chunk 唯一的 Rolldown 输出 Chunk。
 * @param directory Handler Bundle 所在目录。
 * @returns 存在第三方依赖时返回许可文件路径，否则返回 undefined。
 */
async function writeThirdPartyLicenses(chunk: OutputChunk, directory: string): Promise<string | undefined> {
  /** 按包名和版本去重的许可记录。 */
  const records = new Map<string, PackageLicense>();
  for (const moduleId of Object.keys(chunk.modules).sort((a, b) => a.localeCompare(b, 'en'))) {
    /** 当前 Bundle Module 所属的可选第三方包许可。 */
    const record = await packageLicenseForModule(moduleId);
    if (record)
      records.set(`${record.name}@${record.version}`, record);
  }
  if (records.size === 0)
    return undefined;
  /** 按确定顺序拼接的许可文件段落。 */
  const sections = ['THIRD-PARTY LICENSES'];
  for (const [id, record] of [...records].sort(([a], [b]) => a.localeCompare(b, 'en'))) {
    sections.push(`## ${id}\nSPDX: ${record.license}`);
    for (const notice of record.notices)
      sections.push(`### ${notice.name}\n${notice.text}`);
  }
  /** 与 Handler 一同发布的第三方许可文件路径。 */
  const destination = path.join(directory, 'THIRD_PARTY_LICENSES.txt');
  await fs.writeFile(destination, `${sections.join('\n\n')}\n`);
  return destination;
}

/**
 * 扫描 `src/hooks/<id>/hook.ts` 并执行带品牌校验的 TypeScript 定义。
 *
 * @param context Core 提供的 discover 上下文与 TypeScript 加载器。
 * @returns 按 Hook ID 稳定排序的有效定义。
 */
async function discover(context: ModuleDiscoverContext): Promise<DiscoveredHook[]> {
  /** Hooks Module 拥有的固定源码根目录。 */
  const root = path.join(context.config.srcDir, 'hooks');
  /** Hook 根目录的一级目录项。 */
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return [];
    throw error;
  }
  /** 成功加载并通过品牌校验的 Hook。 */
  const result: DiscoveredHook[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
    /** 当前 Hook 候选目录的绝对路径。 */
    const directory = path.join(root, entry.name);
    if (!entry.isDirectory() || !ID_PATTERN.test(entry.name)) {
      context.diagnostics.error('HOOK_ENTRY_INVALID', 'Hook entries must be one-level lowercase kebab-case directories.', {
        phase: 'discover', module: HOOKS_MODULE_NAME,
        location: { path: path.relative(context.config.root, directory).split(path.sep).join('/') },
      });
      continue;
    }
    /** 当前 Hook 必需的 TypeScript 描述文件。 */
    const sourcePath = path.join(directory, 'hook.ts');
    try {
      /** Jiti 执行并解包后的 Hook 定义候选值。 */
      const definition = unwrapDefault(await context.loadTypeScriptModule(sourcePath));
      if (!definition || typeof definition !== 'object' || (definition as { __acpluginHook?: boolean }).__acpluginHook !== true)
        throw new Error('hook.ts must default-export defineHook(...).');
      result.push({ id: entry.name, directory, sourcePath, definition: definition as HookDefinition });
    } catch {
      context.diagnostics.error('HOOK_LOAD_FAILED', `Hook ${entry.name} descriptor could not be loaded.`, {
        phase: 'discover', module: HOOKS_MODULE_NAME,
        location: { path: path.relative(context.config.root, sourcePath).split(path.sep).join('/') },
      });
    }
  }
  return result;
}

/**
 * 验证 Hook 事件、运行函数、Matcher 和跨目标超时约束。
 *
 * @param context Core 提供的项目、目标与诊断上下文。
 * @param hooks discover 阶段成功加载的 Hook。
 */
async function validate(context: ModuleValidateContext, hooks: DiscoveredHook[]): Promise<void> {
  for (const hook of hooks) {
    /** 当前 Hook 已加载但尚未完成语义校验的定义。 */
    const { definition } = hook;
    if (!ALL_EVENTS.has(definition.event))
      context.diagnostics.error('HOOK_EVENT_UNSUPPORTED', `Hook ${hook.id} uses unsupported event ${String(definition.event)}.`, { phase: 'validate', module: HOOKS_MODULE_NAME });
    if (typeof definition.run !== 'function')
      context.diagnostics.error('HOOK_RUN_REQUIRED', `Hook ${hook.id} must define run().`, { phase: 'validate', module: HOOKS_MODULE_NAME });
    if (definition.matcher !== undefined && typeof definition.matcher !== 'string')
      context.diagnostics.error('HOOK_MATCHER_INVALID', `Hook ${hook.id} matcher must be a string.`, { phase: 'validate', module: HOOKS_MODULE_NAME });
    if (definition.matcher) {
      try {
        new RegExp(definition.matcher);
      } catch {
        context.diagnostics.error('HOOK_MATCHER_INVALID', `Hook ${hook.id} matcher is not a valid regular expression.`, { phase: 'validate', module: HOOKS_MODULE_NAME });
      }
    }
    if (definition.timeout !== undefined && (!Number.isFinite(definition.timeout) || definition.timeout <= 0))
      context.diagnostics.error('HOOK_TIMEOUT_INVALID', `Hook ${hook.id} timeout must be a positive number of seconds.`, { phase: 'validate', module: HOOKS_MODULE_NAME });
    if (definition.event === 'SessionEnd' && definition.timeout !== undefined && definition.timeout > 3 && context.config.targets.some(target => target.id === 'codex'))
      context.diagnostics.error('HOOK_TIMEOUT_TARGET_LIMIT', `Hook ${hook.id} exceeds Codex SessionEnd's 3 second maximum.`, { phase: 'validate', module: HOOKS_MODULE_NAME, target: 'codex' });
  }
}

/**
 * 生成单个 Hook 的跨平台隔离运行器源码。
 *
 * 运行器负责限制输入输出大小、规范化平台字段、校验事件结果并把规范决策映射回平台协议。
 * 生成字符串内部是最终 Plugin 运行时代码，按仓库规范不机械注入开发期中文注释。
 *
 * @param hook 当前 Hook 定义及其源码路径。
 * @param target 正在生成的目标平台。
 * @param runnerDirectory 临时运行器目录，用于计算可打包的相对导入路径。
 * @returns 可交给 Rolldown 的 ESM 入口源码。
 */
function runnerSource(hook: DiscoveredHook, target: TargetId, runnerDirectory: string): string {
  /** 从生成运行器到用户 hook.ts 的 ESM 相对导入路径。 */
  let importPath = path.relative(runnerDirectory, hook.sourcePath).split(path.sep).join('/');
  if (!importPath.startsWith('.'))
    importPath = `./${importPath}`;
  return `
const TARGET = ${JSON.stringify(target)};
const MAX_BYTES = 1024 * 1024;
const EVENT_RESULTS = {
  SessionStart: { decisions: ['continue', 'stop'], fields: ['additionalContext'] },
  SessionEnd: { decisions: [], fields: [] },
  UserPromptSubmit: { decisions: ['allow', 'deny'], fields: ['reason', 'additionalContext'] },
  PreToolUse: { decisions: ['allow', 'deny'], fields: ['reason', 'updatedInput', 'additionalContext'] },
  PermissionRequest: { decisions: ['allow', 'deny', 'defer'], fields: ['reason'] },
  PostToolUse: { decisions: ['pass', 'block'], fields: ['reason', 'additionalContext'] },
  PreCompact: { decisions: ['continue', 'stop'], fields: [] },
  PostCompact: { decisions: ['continue', 'stop'], fields: [] },
  SubagentStart: { decisions: [], fields: ['additionalContext'] },
  SubagentStop: { decisions: ['finish', 'continue'], fields: ['reason'] },
  Stop: { decisions: ['finish', 'continue'], fields: ['reason'] },
};

function camel(key) {
  return key.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
}

function normalize(value) {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [camel(key), normalize(child)]));
  }
  return value;
}

function validateResult(event, result) {
  if (result === undefined) return;
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('RESULT_INVALID');
  const contract = EVENT_RESULTS[event] || { decisions: [], fields: [] };
  const allowedFields = new Set(['decision', 'systemMessage', ...contract.fields]);
  if (Object.keys(result).some(field => !allowedFields.has(field))) throw new Error('RESULT_FIELD_INVALID');
  for (const field of ['reason', 'additionalContext', 'systemMessage']) {
    if (result[field] !== undefined && typeof result[field] !== 'string') throw new Error('RESULT_INVALID');
  }
  if (result.decision !== undefined && !contract.decisions.includes(result.decision)) throw new Error('RESULT_DECISION_INVALID');
}

function outputFor(event, result) {
  if (!result) return undefined;
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
    } else if (result.additionalContext) {
      output.hookSpecificOutput = { hookEventName: event, additionalContext: result.additionalContext };
    }
  } else if (event === 'PermissionRequest') {
    if (result.decision === 'allow' || result.decision === 'deny') {
      output.hookSpecificOutput = {
        hookEventName: event,
        decision: { behavior: result.decision, ...(result.reason ? { message: result.reason } : {}) },
      };
    } else if (result.decision === 'defer' && result.reason && !output.systemMessage) {
      output.systemMessage = result.reason;
    }
  } else if (event === 'PostToolUse') {
    if (result.decision === 'block') {
      output.decision = 'block';
      output.reason = result.reason || 'Blocked by hook.';
    }
    if (result.additionalContext)
      output.hookSpecificOutput = { hookEventName: event, additionalContext: result.additionalContext };
  } else if (event === 'UserPromptSubmit') {
    if (result.decision === 'deny') {
      output.decision = 'block';
      output.reason = result.reason || 'Blocked by hook.';
    }
    if (result.additionalContext)
      output.hookSpecificOutput = { hookEventName: event, additionalContext: result.additionalContext };
  } else if (event === 'Stop' || event === 'SubagentStop') {
    if (result.decision === 'continue') {
      output.decision = 'block';
      output.reason = result.reason || 'Continue before stopping.';
    }
  } else if (event === 'SessionStart' || event === 'PreCompact' || event === 'PostCompact') {
    if (result.decision === 'stop') {
      output.continue = false;
      if (result.reason) output.stopReason = result.reason;
    }
    if (result.additionalContext)
      output.hookSpecificOutput = { hookEventName: event, additionalContext: result.additionalContext };
  } else if (event === 'SubagentStart' && result.additionalContext) {
    output.hookSpecificOutput = { hookEventName: event, additionalContext: result.additionalContext };
  }
  return Object.keys(output).length ? output : undefined;
}

async function main() {
  let definition;
  try {
    ({ default: definition } = await import(${JSON.stringify(importPath)}));
  } catch {
    throw new Error('HANDLER_IMPORT_FAILED');
  }
  let source = '';
  for await (const chunk of process.stdin) {
    source += chunk;
    if (Buffer.byteLength(source) > MAX_BYTES) throw new Error('INPUT_TOO_LARGE');
  }
  let raw;
  try {
    raw = JSON.parse(source);
  } catch {
    throw new Error('INPUT_JSON_INVALID');
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('INPUT_OBJECT_REQUIRED');
  if (raw.hook_event_name !== definition.event) throw new Error('INPUT_EVENT_MISMATCH');
  const normalized = normalize(raw);
  normalized.event = raw.hook_event_name;
  let result;
  try {
    result = await definition.run(normalized, {
      target: TARGET,
      pluginRoot: process.env.PLUGIN_ROOT || process.env.CLAUDE_PLUGIN_ROOT || '',
      pluginData: process.env.PLUGIN_DATA || process.env.CLAUDE_PLUGIN_DATA || '',
    });
  } catch {
    throw new Error('HANDLER_FAILED');
  }
  validateResult(raw.hook_event_name, result);
  const output = outputFor(raw.hook_event_name, result);
  if (output) {
    let serialized;
    try {
      serialized = JSON.stringify(output);
    } catch {
      throw new Error('RESULT_SERIALIZATION_FAILED');
    }
    if (Buffer.byteLength(serialized) > MAX_BYTES) throw new Error('OUTPUT_TOO_LARGE');
    process.stdout.write(serialized + '\\n');
  }
}

main().catch((error) => {
  const code = error instanceof Error && /^[A-Z_]+$/.test(error.message) ? error.message : 'HOOK_FAILED';
  process.stderr.write('acplugin hook error: ' + code + '\\n');
  process.exitCode = 1;
});
`;
}

/**
 * 将用户 Hook 及框架运行器打包为单文件目标 Handler，并收集第三方许可。
 *
 * @param hook 待打包的 Hook。
 * @param target 当前目标平台。
 * @param workDir Module 在本次构建中的隔离工作目录。
 * @returns 可由 generate 阶段贡献的 Handler 与可选许可文件。
 */
async function bundleHook(hook: DiscoveredHook, target: TargetId, workDir: string): Promise<BundledHook> {
  /** 当前 Hook 和目标独占的 Bundle 工作目录。 */
  const targetDirectory = path.join(workDir, hook.id, target);
  await fs.mkdir(targetDirectory, { recursive: true });
  /** 动态生成、导入用户 Hook 的 Rolldown 入口。 */
  const runner = path.join(targetDirectory, 'runner.mjs');
  await fs.writeFile(runner, runnerSource(hook, target, targetDirectory));
  /** 保留 Node 内置模块为 external 的内存构建结果。 */
  const output = await rolldownBuild({
    input: runner,
    platform: 'node',
    external: [/^node:/],
    write: false,
    output: { format: 'esm', sourcemap: false, codeSplitting: false, comments: { legal: true } },
  });
  /** 构建产生的 JavaScript Chunk；协议要求严格只有一个。 */
  const chunks = output.output.filter((item): item is OutputChunk => item.type === 'chunk');
  if (chunks.length !== 1 || output.output.some(item => item.type === 'asset'))
    throw new Error(`Hook ${hook.id} must bundle to one JavaScript chunk and no assets.`);
  /** 最终贡献给 Plugin 的独立 ESM Handler。 */
  const bundle = path.join(targetDirectory, 'handler.mjs');
  await fs.writeFile(bundle, chunks[0]!.code);
  /** Bundle 包含第三方依赖时生成的许可汇总。 */
  const licenses = await writeThirdPartyLicenses(chunks[0]!, targetDirectory);
  return licenses ? { handler: bundle, licenses } : { handler: bundle };
}

/**
 * 为每个 Hook 和支持它的目标预构建独立 Handler。
 *
 * @param context Core 提供的 Module 工作目录与目标配置。
 * @param hooks 已通过验证的 Hook。
 * @returns 按 Hook 与目标索引的 Bundle 状态。
 */
async function build(context: ModuleBuildContext, hooks: DiscoveredHook[]): Promise<BuiltHooksState> {
  /** 全部 Hook 的按目标 Bundle 索引。 */
  const bundles = new Map<string, ReadonlyMap<TargetId, BundledHook>>();
  for (const hook of hooks) {
    /** 当前 Hook 在支持目标上的 Bundle。 */
    const targetBundles = new Map<TargetId, BundledHook>();
    for (const target of context.config.targets) {
      if (target.id === 'codex' && CLAUDE_ONLY_HOOK_EVENTS.includes(hook.definition.event as ClaudeOnlyHookEvent))
        continue;
      targetBundles.set(target.id, await bundleHook(hook, target.id, context.workDir));
    }
    bundles.set(hook.id, targetBundles);
  }
  return { bundles };
}

/**
 * 计算单个 Hook 在目标平台上的原生、降级或不支持结论。
 *
 * @param hook 已验证的 Hook。
 * @param target 当前目标平台。
 * @returns 供 strict 策略和构建报告使用的兼容性条目。
 */
function compatibilityFor(hook: DiscoveredHook, target: TargetId): CompatibilityEntry[] {
  if (target === 'codex' && CLAUDE_ONLY_HOOK_EVENTS.includes(hook.definition.event as ClaudeOnlyHookEvent)) {
    return [{
      target,
      subject: `hook:${hook.id}`,
      capability: `event.${hook.definition.event}`,
      level: 'unsupported',
      reason: `${hook.definition.event} is currently a Claude Code-only event.`,
    }];
  }
  if (target === 'codex' && hook.definition.matcher !== undefined && (hook.definition.event === 'UserPromptSubmit' || hook.definition.event === 'Stop')) {
    return [{
      target,
      subject: `hook:${hook.id}`,
      capability: 'matcher',
      level: 'degraded',
      reason: `Codex ignores matcher for ${hook.definition.event}.`,
    }];
  }
  return [{
    target,
    subject: `hook:${hook.id}`,
    capability: `event.${hook.definition.event}`,
    level: 'native',
    reason: `${target} supports local command handlers for ${hook.definition.event}.`,
  }];
}

/**
 * 为目标平台贡献 Hook Handler、许可文件和平台 Hook 清单。
 *
 * @param context 当前目标的 generate 上下文。
 * @param hooks discover 阶段得到的 Hook。
 * @param built build 阶段产生的 Bundle 索引。
 * @returns 交给 Compiler 合并的 Artifact 和兼容性条目。
 */
async function generate(
  context: ModuleGenerateContext,
  hooks: DiscoveredHook[],
  built: BuiltHooksState,
): Promise<TargetContribution> {
  if (hooks.length === 0)
    return {};
  /** 当前目标需要加入 ArtifactGraph 的 Hook 文件。 */
  const artifacts = [];
  /** 按平台事件名分组的命令 Handler 配置。 */
  const hookGroups: Record<string, unknown[]> = {};
  for (const hook of hooks) {
    /** 当前 Hook 在目标平台上已构建的可选 Bundle。 */
    const bundle = built.bundles.get(hook.id)?.get(context.target);
    if (!bundle)
      continue;
    artifacts.push({ path: `hooks/${hook.id}/handler.mjs`, source: { type: 'file' as const, path: bundle.handler }, mode: 0o755 as const });
    if (bundle.licenses)
      artifacts.push({ path: `hooks/${hook.id}/THIRD_PARTY_LICENSES.txt`, source: { type: 'file' as const, path: bundle.licenses }, mode: 0o644 as const });
    /** 目标平台在安装运行时提供的 Plugin 根目录环境变量。 */
    const rootVariable = context.target === 'codex' ? 'PLUGIN_ROOT' : 'CLAUDE_PLUGIN_ROOT';
    /** 平台清单中调用独立 Node Handler 的命令配置。 */
    const handler: Record<string, unknown> = {
      type: 'command',
      command: `node "\${${rootVariable}}/hooks/${hook.id}/handler.mjs"`,
    };
    if (hook.definition.timeout !== undefined)
      handler.timeout = hook.definition.timeout;
    if (hook.definition.statusMessage !== undefined)
      handler.statusMessage = hook.definition.statusMessage;
    /** 可选携带 matcher 的单 Handler 事件组。 */
    const group: Record<string, unknown> = { hooks: [handler] };
    if (hook.definition.matcher !== undefined)
      group.matcher = hook.definition.matcher;
    (hookGroups[hook.definition.event] ??= []).push(group);
  }
  if (Object.keys(hookGroups).length > 0)
    artifacts.push(bytesArtifact('hooks/hooks.json', stableJson({ hooks: hookGroups })));
  return {
    artifacts,
    compatibility: hooks.flatMap(hook => compatibilityFor(hook, context.target)),
  };
}

/**
 * 创建参与 discover、validate、build 和 generate 阶段的官方 Hooks Module。
 *
 * @returns 可直接加入 acplugin.config.ts modules 数组的 Module。
 */
export function hooks(): AcpluginModule<DiscoveredHook[], BuiltHooksState> {
  return {
    name: HOOKS_MODULE_NAME,
    discover,
    validate,
    build,
    generate,
  };
}

/** 官方 Hooks Module 工厂的默认导出。 */
export default hooks;
