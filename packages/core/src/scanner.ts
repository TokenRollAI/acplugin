import { promises as fs } from 'node:fs';
import path from 'node:path';
import { parseDocument } from 'yaml';
import { DiagnosticCollector } from './diagnostics.js';
import { extensionIssues } from './extensions.js';
import type {
  AgentCapability,
  AgentComponent,
  AgentModel,
  ArtifactMode,
  CommandComponent,
  Component,
  ComponentKind,
  ComponentRequires,
  PlatformExtensions,
  PluginProject,
  PublicFile,
  ResolvedConfig,
  SkillAuxiliaryFile,
  SkillComponent,
} from './types.js';

const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const AGENT_MODELS = new Set<AgentModel>(['inherit', 'fast', 'capable']);
const AGENT_CAPABILITIES = new Set<AgentCapability>([
  'filesystem:read', 'filesystem:write', 'search', 'shell', 'network', 'delegate',
]);

interface ParsedMarkdown {
  data: Record<string, unknown>;
  body: string;
}

function relative(root: string, file: string): string {
  return path.relative(root, file).split(path.sep).join('/');
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

function modeFromStat(mode: number): ArtifactMode {
  return mode & 0o111 ? 0o755 : 0o644;
}

async function assertRegularFile(
  file: string,
  root: string,
  diagnostics: DiagnosticCollector,
  phase = 'discover',
): Promise<import('node:fs').Stats | undefined> {
  try {
    const stat = await fs.lstat(file);
    if (stat.isSymbolicLink()) {
      diagnostics.error('SOURCE_SYMLINK_UNSUPPORTED', 'Symbolic links are not supported.', {
        phase, location: { path: relative(root, file) },
      });
      return undefined;
    }
    if (!stat.isFile()) {
      diagnostics.error('SOURCE_NOT_FILE', 'Expected a regular file.', {
        phase, location: { path: relative(root, file) },
      });
      return undefined;
    }
    return stat;
  } catch {
    diagnostics.error('SOURCE_READ_FAILED', 'Cannot read source file.', {
      phase, location: { path: relative(root, file) },
    });
    return undefined;
  }
}

async function parseMarkdown(
  file: string,
  root: string,
  diagnostics: DiagnosticCollector,
): Promise<ParsedMarkdown | undefined> {
  if (!await assertRegularFile(file, root, diagnostics))
    return undefined;

  let source: string;
  try {
    source = await fs.readFile(file, 'utf8');
  } catch {
    diagnostics.error('MARKDOWN_READ_FAILED', 'Cannot read Markdown.', {
      phase: 'discover', location: { path: relative(root, file) },
    });
    return undefined;
  }

  const lines = source.split(/\r?\n/);
  if (lines[0] !== '---') {
    diagnostics.error('FRONTMATTER_REQUIRED', 'A YAML Frontmatter block is required.', {
      phase: 'discover', location: { path: relative(root, file), line: 1, column: 1 },
    });
    return undefined;
  }
  const closing = lines.findIndex((line, index) => index > 0 && line === '---');
  if (closing < 0) {
    diagnostics.error('FRONTMATTER_UNTERMINATED', 'YAML Frontmatter is not terminated.', {
      phase: 'discover', location: { path: relative(root, file), line: 1, column: 1 },
    });
    return undefined;
  }

  const yamlSource = lines.slice(1, closing).join('\n');
  const document = parseDocument(yamlSource, { prettyErrors: false, uniqueKeys: true });
  if (document.errors.length > 0) {
    diagnostics.error('FRONTMATTER_INVALID', 'Invalid YAML Frontmatter.', {
      phase: 'discover', location: { path: relative(root, file), line: 2, column: 1 },
    });
    return undefined;
  }
  const raw = document.toJS() as unknown;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    diagnostics.error('FRONTMATTER_OBJECT_REQUIRED', 'Frontmatter must be a mapping.', {
      phase: 'discover', location: { path: relative(root, file), line: 2, column: 1 },
    });
    return undefined;
  }
  const body = lines.slice(closing + 1).join('\n').trim();
  if (body === '') {
    diagnostics.error('MARKDOWN_BODY_REQUIRED', 'Markdown body must not be empty.', {
      phase: 'discover', location: { path: relative(root, file), line: closing + 2, column: 1 },
    });
    return undefined;
  }
  return { data: raw as Record<string, unknown>, body };
}

function validateId(id: string, sourcePath: string, diagnostics: DiagnosticCollector): boolean {
  if (ID_PATTERN.test(id))
    return true;
  diagnostics.error('COMPONENT_ID_INVALID', `Component ID "${id}" must be lowercase kebab-case.`, {
    phase: 'discover', location: { path: sourcePath },
  });
  return false;
}

function validateFields(
  data: Record<string, unknown>,
  allowed: readonly string[],
  sourcePath: string,
  diagnostics: DiagnosticCollector,
): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(data)) {
    if (!allowedSet.has(key)) {
      diagnostics.error('FRONTMATTER_FIELD_UNKNOWN', `Unknown Frontmatter field "${key}".`, {
        phase: 'discover', location: { path: sourcePath }, fieldPath: [key],
      });
    }
  }
}

function stringField(
  data: Record<string, unknown>,
  key: string,
  sourcePath: string,
  diagnostics: DiagnosticCollector,
  required = false,
): string | undefined {
  const value = data[key];
  if (value === undefined && !required)
    return undefined;
  if (typeof value !== 'string' || value.trim() === '') {
    diagnostics.error('FRONTMATTER_STRING_REQUIRED', `${key} must be a non-empty string.`, {
      phase: 'discover', location: { path: sourcePath }, fieldPath: [key],
    });
    return undefined;
  }
  return value.trim();
}

function stringArray(
  value: unknown,
  fieldPath: readonly string[],
  sourcePath: string,
  diagnostics: DiagnosticCollector,
): string[] {
  if (value === undefined)
    return [];
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || item === '')) {
    diagnostics.error('FRONTMATTER_STRING_ARRAY', `${fieldPath.join('.')} must be an array of non-empty strings.`, {
      phase: 'discover', location: { path: sourcePath }, fieldPath,
    });
    return [];
  }
  const result = value as string[];
  if (new Set(result).size !== result.length) {
    diagnostics.error('COMPONENT_REQUIRES_DUPLICATE', `${fieldPath.join('.')} contains duplicate IDs.`, {
      phase: 'discover', location: { path: sourcePath }, fieldPath,
    });
  }
  return result;
}

function parseRequires(data: unknown, sourcePath: string, diagnostics: DiagnosticCollector): ComponentRequires {
  if (data === undefined)
    return { skills: [], agents: [] };
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    diagnostics.error('COMPONENT_REQUIRES_INVALID', 'requires must be a mapping.', {
      phase: 'discover', location: { path: sourcePath }, fieldPath: ['requires'],
    });
    return { skills: [], agents: [] };
  }
  const object = data as Record<string, unknown>;
  for (const key of Object.keys(object)) {
    if (key !== 'skills' && key !== 'agents') {
      diagnostics.error('COMPONENT_REQUIRES_KIND', `requires.${key} is not supported.`, {
        phase: 'discover', location: { path: sourcePath }, fieldPath: ['requires', key],
      });
    }
  }
  return {
    skills: stringArray(object.skills, ['requires', 'skills'], sourcePath, diagnostics),
    agents: stringArray(object.agents, ['requires', 'agents'], sourcePath, diagnostics),
  };
}

function parseExtensions(data: unknown, sourcePath: string, diagnostics: DiagnosticCollector): PlatformExtensions {
  if (data === undefined)
    return {};
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    diagnostics.error('EXTENSIONS_INVALID', 'extensions must be a mapping.', {
      phase: 'discover', location: { path: sourcePath }, fieldPath: ['extensions'],
    });
    return {};
  }
  const object = data as Record<string, unknown>;
  for (const [key, value] of Object.entries(object)) {
    if (key !== 'claude-code' && key !== 'codex') {
      diagnostics.error('EXTENSION_TARGET_UNKNOWN', `Unknown extension target "${key}".`, {
        phase: 'discover', location: { path: sourcePath }, fieldPath: ['extensions', key],
      });
      continue;
    }
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      diagnostics.error('EXTENSION_VALUE_INVALID', `Extension target "${key}" must be a mapping.`, {
        phase: 'discover', location: { path: sourcePath }, fieldPath: ['extensions', key],
      });
      continue;
    }
    for (const issue of extensionIssues(value, ['extensions', key])) {
      diagnostics.error('EXTENSION_SEMANTICS_INVALID', issue.message, {
        phase: 'discover', location: { path: sourcePath }, fieldPath: issue.path,
      });
    }
  }
  return object as PlatformExtensions;
}

async function listDirectory(directory: string): Promise<import('node:fs').Dirent[]> {
  try {
    return (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return [];
    throw error;
  }
}

async function scanCommands(config: ResolvedConfig, diagnostics: DiagnosticCollector): Promise<CommandComponent[]> {
  const directory = path.join(config.srcDir, 'commands');
  const result: CommandComponent[] = [];
  for (const entry of await listDirectory(directory)) {
    const file = path.join(directory, entry.name);
    const sourcePath = relative(config.root, file);
    if (!entry.isFile() || !entry.name.endsWith('.md')) {
      diagnostics.error('COMMAND_ENTRY_INVALID', 'Commands must be one-level .md files.', { phase: 'discover', location: { path: sourcePath } });
      continue;
    }
    const id = entry.name.slice(0, -3);
    if (!validateId(id, sourcePath, diagnostics))
      continue;
    const parsed = await parseMarkdown(file, config.root, diagnostics);
    if (!parsed)
      continue;
    validateFields(parsed.data, ['description', 'argumentHint', 'requires', 'extensions'], sourcePath, diagnostics);
    const description = stringField(parsed.data, 'description', sourcePath, diagnostics, true);
    if (!description)
      continue;
    const command: CommandComponent = {
      kind: 'command', id, description, body: parsed.body, sourcePath,
      requires: parseRequires(parsed.data.requires, sourcePath, diagnostics),
      extensions: parseExtensions(parsed.data.extensions, sourcePath, diagnostics),
    };
    const argumentHint = stringField(parsed.data, 'argumentHint', sourcePath, diagnostics);
    if (argumentHint !== undefined)
      command.argumentHint = argumentHint;
    result.push(command);
  }
  return result;
}

async function collectSkillAuxiliary(
  directory: string,
  config: ResolvedConfig,
  diagnostics: DiagnosticCollector,
  prefix = '',
): Promise<SkillAuxiliaryFile[]> {
  const result: SkillAuxiliaryFile[] = [];
  for (const entry of await listDirectory(path.join(directory, prefix))) {
    if (prefix === '' && entry.name === 'SKILL.md')
      continue;
    const relativePath = path.posix.join(prefix.split(path.sep).join('/'), entry.name);
    const file = path.join(directory, relativePath);
    if (entry.isSymbolicLink()) {
      diagnostics.error('SOURCE_SYMLINK_UNSUPPORTED', 'Symbolic links are not supported.', {
        phase: 'discover', location: { path: relative(config.root, file) },
      });
    } else if (entry.isDirectory()) {
      result.push(...await collectSkillAuxiliary(directory, config, diagnostics, relativePath));
    } else if (entry.isFile()) {
      const stat = await fs.stat(file);
      result.push({ path: relativePath, sourcePath: file, mode: modeFromStat(stat.mode) });
    } else {
      diagnostics.error('SOURCE_ENTRY_UNSUPPORTED', 'Only regular files and directories are supported.', {
        phase: 'discover', location: { path: relative(config.root, file) },
      });
    }
  }
  return result;
}

async function scanSkills(config: ResolvedConfig, diagnostics: DiagnosticCollector): Promise<SkillComponent[]> {
  const directory = path.join(config.srcDir, 'skills');
  const result: SkillComponent[] = [];
  for (const entry of await listDirectory(directory)) {
    const skillDirectory = path.join(directory, entry.name);
    const sourcePath = relative(config.root, skillDirectory);
    if (!entry.isDirectory()) {
      diagnostics.error('SKILL_ENTRY_INVALID', 'Skills must be one-level directories.', { phase: 'discover', location: { path: sourcePath } });
      continue;
    }
    if (!validateId(entry.name, sourcePath, diagnostics))
      continue;
    const file = path.join(skillDirectory, 'SKILL.md');
    if (!await exists(file)) {
      diagnostics.error('SKILL_FILE_REQUIRED', 'Skill directory must contain SKILL.md.', { phase: 'discover', location: { path: sourcePath } });
      continue;
    }
    const parsed = await parseMarkdown(file, config.root, diagnostics);
    if (!parsed)
      continue;
    const markdownPath = relative(config.root, file);
    validateFields(parsed.data, ['description', 'invocation', 'requires', 'extensions'], markdownPath, diagnostics);
    const description = stringField(parsed.data, 'description', markdownPath, diagnostics, true);
    if (!description)
      continue;
    let user = true;
    let model = true;
    if (parsed.data.invocation !== undefined) {
      if (parsed.data.invocation === null || typeof parsed.data.invocation !== 'object' || Array.isArray(parsed.data.invocation)) {
        diagnostics.error('SKILL_INVOCATION_INVALID', 'invocation must be a mapping.', { phase: 'discover', location: { path: markdownPath }, fieldPath: ['invocation'] });
      } else {
        const invocation = parsed.data.invocation as Record<string, unknown>;
        for (const key of Object.keys(invocation)) {
          if (key !== 'user' && key !== 'model')
            diagnostics.error('SKILL_INVOCATION_FIELD', `Unknown invocation field "${key}".`, { phase: 'discover', location: { path: markdownPath }, fieldPath: ['invocation', key] });
        }
        if (typeof invocation.user === 'boolean')
          user = invocation.user;
        else if (invocation.user !== undefined)
          diagnostics.error('SKILL_INVOCATION_BOOLEAN', 'invocation.user must be boolean.', { phase: 'discover', location: { path: markdownPath }, fieldPath: ['invocation', 'user'] });
        if (typeof invocation.model === 'boolean')
          model = invocation.model;
        else if (invocation.model !== undefined)
          diagnostics.error('SKILL_INVOCATION_BOOLEAN', 'invocation.model must be boolean.', { phase: 'discover', location: { path: markdownPath }, fieldPath: ['invocation', 'model'] });
      }
    }
    if (!user && !model)
      diagnostics.error('SKILL_INVOCATION_EMPTY', 'invocation.user and invocation.model cannot both be false.', { phase: 'discover', location: { path: markdownPath }, fieldPath: ['invocation'] });
    result.push({
      kind: 'skill', id: entry.name, description, invocation: { user, model },
      body: parsed.body, sourcePath: markdownPath,
      requires: parseRequires(parsed.data.requires, markdownPath, diagnostics),
      extensions: parseExtensions(parsed.data.extensions, markdownPath, diagnostics),
      auxiliaryFiles: await collectSkillAuxiliary(skillDirectory, config, diagnostics),
    });
  }
  return result;
}

async function scanAgents(config: ResolvedConfig, diagnostics: DiagnosticCollector): Promise<AgentComponent[]> {
  const directory = path.join(config.srcDir, 'agents');
  const result: AgentComponent[] = [];
  for (const entry of await listDirectory(directory)) {
    const file = path.join(directory, entry.name);
    const sourcePath = relative(config.root, file);
    if (!entry.isFile() || !entry.name.endsWith('.md')) {
      diagnostics.error('AGENT_ENTRY_INVALID', 'Agents must be one-level .md files.', { phase: 'discover', location: { path: sourcePath } });
      continue;
    }
    const id = entry.name.slice(0, -3);
    if (!validateId(id, sourcePath, diagnostics))
      continue;
    const parsed = await parseMarkdown(file, config.root, diagnostics);
    if (!parsed)
      continue;
    validateFields(parsed.data, ['description', 'model', 'capabilities', 'requires', 'extensions'], sourcePath, diagnostics);
    const description = stringField(parsed.data, 'description', sourcePath, diagnostics, true);
    if (!description)
      continue;
    const modelValue = parsed.data.model ?? 'inherit';
    const model = typeof modelValue === 'string' && AGENT_MODELS.has(modelValue as AgentModel)
      ? modelValue as AgentModel
      : 'inherit';
    if (model !== modelValue)
      diagnostics.error('AGENT_MODEL_INVALID', 'model must be inherit, fast, or capable.', { phase: 'discover', location: { path: sourcePath }, fieldPath: ['model'] });
    const capabilityValues = stringArray(parsed.data.capabilities, ['capabilities'], sourcePath, diagnostics);
    const capabilities = capabilityValues.filter((capability): capability is AgentCapability => {
      if (AGENT_CAPABILITIES.has(capability as AgentCapability))
        return true;
      diagnostics.error('AGENT_CAPABILITY_INVALID', `Unknown capability "${capability}".`, { phase: 'discover', location: { path: sourcePath }, fieldPath: ['capabilities'] });
      return false;
    });
    result.push({
      kind: 'agent', id, description, model, capabilities,
      body: parsed.body, sourcePath,
      requires: parseRequires(parsed.data.requires, sourcePath, diagnostics),
      extensions: parseExtensions(parsed.data.extensions, sourcePath, diagnostics),
    });
  }
  return result;
}

async function collectPublicTree(
  source: string,
  target: string,
  config: ResolvedConfig,
  diagnostics: DiagnosticCollector,
): Promise<PublicFile[]> {
  let stat: import('node:fs').Stats;
  try {
    stat = await fs.lstat(source);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      diagnostics.error('PUBLIC_SOURCE_MISSING', 'Public copy source does not exist.', { phase: 'discover', location: { path: relative(config.root, source) } });
      return [];
    }
    throw error;
  }
  if (stat.isSymbolicLink()) {
    diagnostics.error('SOURCE_SYMLINK_UNSUPPORTED', 'Symbolic links are not supported.', { phase: 'discover', location: { path: relative(config.root, source) } });
    return [];
  }
  if (stat.isFile())
    return [{ sourcePath: source, targetPath: target.split(path.sep).join('/'), mode: modeFromStat(stat.mode) }];
  if (!stat.isDirectory()) {
    diagnostics.error('SOURCE_ENTRY_UNSUPPORTED', 'Only regular files and directories are supported.', { phase: 'discover', location: { path: relative(config.root, source) } });
    return [];
  }
  const result: PublicFile[] = [];
  for (const entry of await listDirectory(source))
    result.push(...await collectPublicTree(path.join(source, entry.name), path.join(target, entry.name), config, diagnostics));
  return result;
}

async function scanPublic(config: ResolvedConfig, diagnostics: DiagnosticCollector): Promise<PublicFile[]> {
  if (!config.public.enabled || !await exists(config.public.dir))
    return [];
  if (!config.public.copy)
    return collectPublicTree(config.public.dir, '', config, diagnostics);
  const result: PublicFile[] = [];
  for (const rule of config.public.copy)
    result.push(...await collectPublicTree(path.join(config.public.dir, rule.from), rule.to, config, diagnostics));
  return result;
}

function componentKey(kind: ComponentKind, id: string): string {
  return `${kind}:${id}`;
}

function validateGraph(components: readonly Component[], diagnostics: DiagnosticCollector): void {
  const byKey = new Map(components.map(component => [componentKey(component.kind, component.id), component]));
  const edges = new Map<string, string[]>();
  for (const component of components) {
    const from = componentKey(component.kind, component.id);
    const targets = [
      ...component.requires.skills.map(id => componentKey('skill', id)),
      ...component.requires.agents.map(id => componentKey('agent', id)),
    ];
    edges.set(from, targets);
    for (const target of targets) {
      if (target === from) {
        diagnostics.error('COMPONENT_DEPENDENCY_SELF', `${from} cannot require itself.`, { phase: 'validate', component: { kind: component.kind, id: component.id }, location: { path: component.sourcePath } });
      } else if (!byKey.has(target)) {
        diagnostics.error('COMPONENT_DEPENDENCY_MISSING', `${from} requires missing ${target}.`, { phase: 'validate', component: { kind: component.kind, id: component.id }, location: { path: component.sourcePath } });
      }
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const stack: string[] = [];
  const reported = new Set<string>();
  const visit = (node: string): void => {
    if (visited.has(node))
      return;
    if (visiting.has(node)) {
      const start = stack.indexOf(node);
      const cycle = [...stack.slice(start), node];
      const signature = cycle.join(' -> ');
      if (!reported.has(signature)) {
        diagnostics.error('COMPONENT_DEPENDENCY_CYCLE', `Dependency cycle: ${signature}`, { phase: 'validate' });
        reported.add(signature);
      }
      return;
    }
    visiting.add(node);
    stack.push(node);
    for (const target of edges.get(node) ?? []) {
      if (byKey.has(target))
        visit(target);
    }
    stack.pop();
    visiting.delete(node);
    visited.add(node);
  };
  for (const key of [...byKey.keys()].sort())
    visit(key);
}

async function validateModuleDirectories(config: ResolvedConfig, diagnostics: DiagnosticCollector): Promise<void> {
  const checks = [
    { directory: 'hooks', module: '@tokenroll/acplugin-module-hooks' },
    { directory: 'mcp', module: '@tokenroll/acplugin-module-mcp' },
  ];
  const enabled = new Set(config.modules.map(module => module.name));
  for (const check of checks) {
    const directory = path.join(config.srcDir, check.directory);
    if ((await listDirectory(directory)).length > 0 && !enabled.has(check.module)) {
      diagnostics.error('MODULE_REQUIRED', `Source under src/${check.directory} requires ${check.module}.`, {
        phase: 'discover', location: { path: relative(config.root, directory) }, hint: `Add ${check.module} to modules.`,
      });
    }
  }
}

export async function scanProject(
  config: ResolvedConfig,
  diagnostics = new DiagnosticCollector(),
): Promise<{ project: PluginProject; diagnostics: DiagnosticCollector }> {
  await validateModuleDirectories(config, diagnostics);
  const [commands, skills, agents, publicFiles] = await Promise.all([
    scanCommands(config, diagnostics),
    scanSkills(config, diagnostics),
    scanAgents(config, diagnostics),
    scanPublic(config, diagnostics),
  ]);
  validateGraph([...commands, ...skills, ...agents], diagnostics);

  const project: PluginProject = {
    root: config.root,
    name: config.name,
    version: config.version,
    description: config.description,
    commands,
    skills,
    agents,
    publicFiles,
  };
  if (config.displayName !== undefined)
    project.displayName = config.displayName;
  return { project, diagnostics };
}
