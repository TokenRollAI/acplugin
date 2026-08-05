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

export const HOOKS_MODULE_NAME = '@tokenroll/acplugin-module-hooks';

export const PORTABLE_HOOK_EVENTS = [
  'SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PreToolUse',
  'PermissionRequest', 'PostToolUse', 'PreCompact', 'PostCompact',
  'SubagentStart', 'SubagentStop', 'Stop',
] as const;

export const CLAUDE_ONLY_HOOK_EVENTS = [
  'Setup', 'UserPromptExpansion', 'PermissionDenied', 'PostToolUseFailure',
  'PostToolBatch', 'Notification', 'MessageDisplay', 'TaskCreated', 'TaskCompleted',
  'StopFailure', 'TeammateIdle', 'InstructionsLoaded', 'ConfigChange', 'CwdChanged',
  'DirectoryAdded', 'FileChanged', 'WorktreeCreate', 'WorktreeRemove',
  'Elicitation', 'ElicitationResult',
] as const;

export type PortableHookEvent = typeof PORTABLE_HOOK_EVENTS[number];
export type ClaudeOnlyHookEvent = typeof CLAUDE_ONLY_HOOK_EVENTS[number];
export type HookEvent = PortableHookEvent | ClaudeOnlyHookEvent;

export interface HookInput<Event extends HookEvent = HookEvent> {
  event: Event;
  sessionId: string;
  transcriptPath?: string | null;
  cwd: string;
  [field: string]: unknown;
}

export interface HookRuntimeContext {
  target: TargetId;
  pluginRoot: string;
  pluginData: string;
}

interface AdvisoryResult {
  systemMessage?: string;
}

interface ContextResult extends AdvisoryResult {
  additionalContext?: string;
}

interface DecisionResult<Decision extends string> extends AdvisoryResult {
  decision?: Decision;
  reason?: string;
}

interface FlowResult<Decision extends string> extends AdvisoryResult {
  decision?: Decision;
}

export interface HookResultByEvent {
  SessionStart: ContextResult & FlowResult<'continue' | 'stop'>;
  SessionEnd: AdvisoryResult;
  UserPromptSubmit: ContextResult & DecisionResult<'allow' | 'deny'>;
  PreToolUse: ContextResult & DecisionResult<'allow' | 'deny'> & { updatedInput?: unknown };
  PermissionRequest: DecisionResult<'allow' | 'deny' | 'defer'>;
  PostToolUse: ContextResult & DecisionResult<'pass' | 'block'>;
  PreCompact: FlowResult<'continue' | 'stop'>;
  PostCompact: FlowResult<'continue' | 'stop'>;
  SubagentStart: ContextResult;
  SubagentStop: DecisionResult<'finish' | 'continue'>;
  Stop: DecisionResult<'finish' | 'continue'>;
}

export type HookResult<Event extends HookEvent = HookEvent>
  = void
    | (Event extends keyof HookResultByEvent ? HookResultByEvent[Event] : AdvisoryResult);

export interface HookDefinition<Event extends HookEvent = HookEvent> {
  readonly __acpluginHook: true;
  event: Event;
  matcher?: string;
  timeout?: number;
  statusMessage?: string;
  run(input: HookInput<Event>, context: HookRuntimeContext): HookResult<Event> | Promise<HookResult<Event>>;
}

export type HookDefinitionInput<Event extends HookEvent = HookEvent> = Omit<HookDefinition<Event>, '__acpluginHook'>;

export function defineHook<Event extends HookEvent>(definition: HookDefinitionInput<Event>): HookDefinition<Event> {
  return Object.freeze({ ...definition, __acpluginHook: true });
}

interface DiscoveredHook {
  id: string;
  directory: string;
  sourcePath: string;
  definition: HookDefinition;
}

interface BuiltHooksState {
  bundles: ReadonlyMap<string, ReadonlyMap<TargetId, BundledHook>>;
}

interface BundledHook {
  handler: string;
  licenses?: string;
}

const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ALL_EVENTS = new Set<HookEvent>([...PORTABLE_HOOK_EVENTS, ...CLAUDE_ONLY_HOOK_EVENTS]);

function unwrapDefault(value: unknown): unknown {
  if (value && typeof value === 'object' && 'default' in value)
    return (value as { default: unknown }).default;
  return value;
}

interface PackageLicense {
  name: string;
  version: string;
  license: string;
  notices: readonly { name: string; text: string }[];
}

async function packageLicenseForModule(moduleId: string): Promise<PackageLicense | undefined> {
  const normalized = moduleId.replace(/\?.*$/, '').replace(/^\0/, '');
  if (!normalized.includes(`${path.sep}node_modules${path.sep}`))
    return undefined;
  let directory = path.dirname(normalized);
  const root = path.parse(directory).root;
  while (directory !== root) {
    try {
      const manifest = JSON.parse(await fs.readFile(path.join(directory, 'package.json'), 'utf8')) as {
        name?: unknown;
        version?: unknown;
        license?: unknown;
      };
      if (typeof manifest.name === 'string' && typeof manifest.version === 'string') {
        const entries = await fs.readdir(directory, { withFileTypes: true });
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

async function writeThirdPartyLicenses(chunk: OutputChunk, directory: string): Promise<string | undefined> {
  const records = new Map<string, PackageLicense>();
  for (const moduleId of Object.keys(chunk.modules).sort((a, b) => a.localeCompare(b, 'en'))) {
    const record = await packageLicenseForModule(moduleId);
    if (record)
      records.set(`${record.name}@${record.version}`, record);
  }
  if (records.size === 0)
    return undefined;
  const sections = ['THIRD-PARTY LICENSES'];
  for (const [id, record] of [...records].sort(([a], [b]) => a.localeCompare(b, 'en'))) {
    sections.push(`## ${id}\nSPDX: ${record.license}`);
    for (const notice of record.notices)
      sections.push(`### ${notice.name}\n${notice.text}`);
  }
  const destination = path.join(directory, 'THIRD_PARTY_LICENSES.txt');
  await fs.writeFile(destination, `${sections.join('\n\n')}\n`);
  return destination;
}

async function discover(context: ModuleDiscoverContext): Promise<DiscoveredHook[]> {
  const root = path.join(context.config.srcDir, 'hooks');
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return [];
    throw error;
  }
  const result: DiscoveredHook[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
    const directory = path.join(root, entry.name);
    if (!entry.isDirectory() || !ID_PATTERN.test(entry.name)) {
      context.diagnostics.error('HOOK_ENTRY_INVALID', 'Hook entries must be one-level lowercase kebab-case directories.', {
        phase: 'discover', module: HOOKS_MODULE_NAME,
        location: { path: path.relative(context.config.root, directory).split(path.sep).join('/') },
      });
      continue;
    }
    const sourcePath = path.join(directory, 'hook.ts');
    try {
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

async function validate(context: ModuleValidateContext, hooks: DiscoveredHook[]): Promise<void> {
  for (const hook of hooks) {
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

function runnerSource(hook: DiscoveredHook, target: TargetId, runnerDirectory: string): string {
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

async function bundleHook(hook: DiscoveredHook, target: TargetId, workDir: string): Promise<BundledHook> {
  const targetDirectory = path.join(workDir, hook.id, target);
  await fs.mkdir(targetDirectory, { recursive: true });
  const runner = path.join(targetDirectory, 'runner.mjs');
  await fs.writeFile(runner, runnerSource(hook, target, targetDirectory));
  const output = await rolldownBuild({
    input: runner,
    platform: 'node',
    external: [/^node:/],
    write: false,
    output: { format: 'esm', sourcemap: false, codeSplitting: false, comments: { legal: true } },
  });
  const chunks = output.output.filter((item): item is OutputChunk => item.type === 'chunk');
  if (chunks.length !== 1 || output.output.some(item => item.type === 'asset'))
    throw new Error(`Hook ${hook.id} must bundle to one JavaScript chunk and no assets.`);
  const bundle = path.join(targetDirectory, 'handler.mjs');
  await fs.writeFile(bundle, chunks[0]!.code);
  const licenses = await writeThirdPartyLicenses(chunks[0]!, targetDirectory);
  return licenses ? { handler: bundle, licenses } : { handler: bundle };
}

async function build(context: ModuleBuildContext, hooks: DiscoveredHook[]): Promise<BuiltHooksState> {
  const bundles = new Map<string, ReadonlyMap<TargetId, BundledHook>>();
  for (const hook of hooks) {
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

async function generate(
  context: ModuleGenerateContext,
  hooks: DiscoveredHook[],
  built: BuiltHooksState,
): Promise<TargetContribution> {
  if (hooks.length === 0)
    return {};
  const artifacts = [];
  const hookGroups: Record<string, unknown[]> = {};
  for (const hook of hooks) {
    const bundle = built.bundles.get(hook.id)?.get(context.target);
    if (!bundle)
      continue;
    artifacts.push({ path: `hooks/${hook.id}/handler.mjs`, source: { type: 'file' as const, path: bundle.handler }, mode: 0o755 as const });
    if (bundle.licenses)
      artifacts.push({ path: `hooks/${hook.id}/THIRD_PARTY_LICENSES.txt`, source: { type: 'file' as const, path: bundle.licenses }, mode: 0o644 as const });
    const rootVariable = context.target === 'codex' ? 'PLUGIN_ROOT' : 'CLAUDE_PLUGIN_ROOT';
    const handler: Record<string, unknown> = {
      type: 'command',
      command: `node "\${${rootVariable}}/hooks/${hook.id}/handler.mjs"`,
    };
    if (hook.definition.timeout !== undefined)
      handler.timeout = hook.definition.timeout;
    if (hook.definition.statusMessage !== undefined)
      handler.statusMessage = hook.definition.statusMessage;
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

export function hooks(): AcpluginModule<DiscoveredHook[], BuiltHooksState> {
  return {
    name: HOOKS_MODULE_NAME,
    discover,
    validate,
    build,
    generate,
  };
}

export default hooks;
