import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import matter from 'gray-matter';
import { input } from '@inquirer/prompts';
import { markdownWithFrontmatter, resolveConfig, scanProject, stableJson, type Diagnostic } from '@acplugin/core';
import {
  cleanupTempDir,
  downloadGitHubRepo,
  getTempRoot,
  parseGitHubSource,
} from './legacy/github.js';
import { scanClaudeProject } from './legacy/scanner/claude.js';
import {
  hasMarketplace,
  isSinglePlugin,
  scanAllPlugins,
  scanPlugin,
} from './legacy/scanner/plugin.js';
import type {
  Agent,
  Command,
  MCPServer,
  PluginScanResult,
  ScanResult,
  Skill,
} from './legacy/types.js';
import type { Hooks } from './legacy/types.js';

export interface MigrationOptions {
  cwd?: string;
  source: string;
  destination?: string;
  subPath?: string;
  plugin?: string;
  all?: boolean;
  name?: string;
  description?: string;
  dryRun?: boolean;
  strict?: boolean;
}

export type MigrationOutcome = 'migrated' | 'degraded' | 'unmapped' | 'skipped';

export interface MigrationItem {
  kind: string;
  id: string;
  outcome: MigrationOutcome;
  source?: string;
  destination?: string;
  message?: string;
}

export interface MigrationReport {
  schemaVersion: '1';
  sourceType: 'project' | 'plugin' | 'marketplace';
  projects: readonly string[];
  items: readonly MigrationItem[];
  diagnostics: readonly Diagnostic[];
  success: boolean;
  dryRun: boolean;
}

const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function relative(root: string, file: string): string {
  return path.relative(root, file).split(path.sep).join('/');
}

function safeId(value: string): string {
  const id = value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return id || 'migrated-item';
}

function isGitHubSource(source: string): boolean {
  return source.startsWith('github:')
    || /^https?:\/\/github\.com\//.test(source)
    || (/^[A-Za-z0-9_-]+\/[A-Za-z0-9._-]+(?:#.+)?$/.test(source) && !path.isAbsolute(source));
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

async function copyText(destination: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.writeFile(destination, content);
}

function migrateSkill(skill: Skill, projectRoot: string, outputRoot: string, items: MigrationItem[]): Promise<void>[] {
  const id = safeId(skill.dirName);
  const description = skill.frontmatter.description || skill.frontmatter.when_to_use || `Migrated Skill ${id}.`;
  let user = skill.frontmatter['user-invocable'] ?? true;
  const model = !(skill.frontmatter['disable-model-invocation'] ?? false);
  let outcome: MigrationOutcome = ID_PATTERN.test(skill.dirName) && skill.frontmatter.description ? 'migrated' : 'degraded';
  if (!user && !model) {
    user = true;
    outcome = 'degraded';
  }
  const destination = `src/skills/${id}/SKILL.md`;
  items.push({
    kind: 'skill', id, outcome,
    source: relative(projectRoot, skill.sourcePath), destination,
    ...(outcome === 'degraded' ? { message: 'Identity, description, or invocation required a canonical fallback.' } : {}),
  });
  const writes = [copyText(path.join(outputRoot, destination), markdownWithFrontmatter({
    description,
    invocation: { user, model },
  }, skill.body))];
  for (const auxiliary of skill.auxFiles) {
    writes.push(copyText(path.join(outputRoot, 'src/skills', id, auxiliary.relativePath), auxiliary.content));
  }
  return writes;
}

function migrateCommand(command: Command, projectRoot: string, outputRoot: string, items: MigrationItem[]): Promise<void> {
  const id = safeId(command.name);
  let body = command.content;
  let description = `Migrated Command ${id}.`;
  let outcome: MigrationOutcome = ID_PATTERN.test(command.name) ? 'migrated' : 'degraded';
  try {
    const parsed = matter(command.content);
    body = parsed.content.trim();
    if (typeof parsed.data.description === 'string' && parsed.data.description.trim())
      description = parsed.data.description.trim();
    else
      outcome = 'degraded';
  } catch {
    outcome = 'degraded';
  }
  body = body.replaceAll('$ARGUMENTS', '{{arguments}}');
  const destination = `src/commands/${id}.md`;
  items.push({
    kind: 'command', id, outcome,
    source: relative(projectRoot, command.sourcePath), destination,
    ...(outcome === 'degraded' ? { message: 'A canonical description or identity fallback was required.' } : {}),
  });
  return copyText(path.join(outputRoot, destination), markdownWithFrontmatter({ description }, body));
}

function mappedModel(value: string | undefined): 'inherit' | 'fast' | 'capable' {
  if (value === 'haiku')
    return 'fast';
  if (value === 'sonnet' || value === 'opus')
    return 'capable';
  return 'inherit';
}

function migrateAgent(agent: Agent, projectRoot: string, outputRoot: string, items: MigrationItem[]): Promise<void> {
  const id = safeId(agent.fileName);
  const description = agent.frontmatter.description || `Migrated Agent ${id}.`;
  const knownModel = agent.frontmatter.model === undefined || ['inherit', 'haiku', 'sonnet', 'opus'].includes(agent.frontmatter.model);
  const outcome: MigrationOutcome = ID_PATTERN.test(agent.fileName) && agent.frontmatter.description && knownModel ? 'migrated' : 'degraded';
  const destination = `src/agents/${id}.md`;
  items.push({
    kind: 'agent', id, outcome,
    source: relative(projectRoot, agent.sourcePath), destination,
    ...(outcome === 'degraded' ? { message: 'Unsupported legacy model/tool metadata was omitted or generalized.' } : {}),
  });
  return copyText(path.join(outputRoot, destination), markdownWithFrontmatter({
    description,
    model: mappedModel(agent.frontmatter.model),
  }, agent.body));
}

function environmentReference(value: string): string | undefined {
  const match = value.match(/^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/);
  return match?.[1];
}

function remoteMcpSource(server: MCPServer): string | undefined {
  if (!server.url || !['http', 'streamable-http', undefined].includes(server.type))
    return undefined;
  let endpoint: URL;
  try {
    endpoint = new URL(server.url);
  } catch {
    return undefined;
  }
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash)
    return undefined;
  const headers: Record<string, unknown> = {};
  let auth: Record<string, string> | undefined;
  for (const [name, value] of Object.entries(server.headers ?? {})) {
    const bearer = name.toLowerCase() === 'authorization' && value.match(/^Bearer \$\{([A-Za-z_][A-Za-z0-9_]*)\}$/);
    if (bearer) {
      auth = { type: 'bearer', env: bearer[1]! };
      continue;
    }
    const env = environmentReference(value);
    if (!env)
      return undefined;
    headers[name] = { env };
  }
  const descriptor = [
    `import { defineMcpServer } from '@tokenroll/acplugin-module-mcp';`,
    '',
    'export default defineMcpServer({',
    `  transport: 'http',`,
    `  url: ${JSON.stringify(endpoint.href)},`,
    ...(auth ? [`  auth: ${JSON.stringify(auth)},`] : []),
    ...(Object.keys(headers).length ? [`  headers: ${JSON.stringify(headers, null, 2).replaceAll('\n', '\n  ')},`] : []),
    '});',
    '',
  ];
  return descriptor.join('\n');
}

function redactedMcpServer(server: MCPServer): Record<string, unknown> {
  let url = server.url;
  if (url) {
    try {
      const parsed = new URL(url);
      parsed.username = '';
      parsed.password = '';
      parsed.search = '';
      parsed.hash = '';
      url = parsed.href;
    } catch {
      url = '<redacted-invalid-url>';
    }
  }
  return {
    name: server.name,
    ...(server.type === undefined ? {} : { type: server.type }),
    ...(server.command === undefined ? {} : { command: server.command }),
    ...(server.args === undefined ? {} : { args: server.args.map(() => '<redacted>') }),
    ...(server.env === undefined ? {} : { env: Object.fromEntries(Object.keys(server.env).sort().map(name => [name, '<redacted>'])) }),
    ...(url === undefined ? {} : { url }),
    ...(server.headers === undefined ? {} : { headers: Object.fromEntries(Object.keys(server.headers).sort().map(name => [name, '<redacted>'])) }),
  };
}

async function unmapped(
  outputRoot: string,
  category: string,
  filename: string,
  content: string,
): Promise<string> {
  const destination = `.acplugin-migration/unmapped/${category}/${filename}`;
  await copyText(path.join(outputRoot, destination), content);
  return destination;
}

function hookReferenceCandidates(hooks: Hooks): string[] {
  const references = new Set<string>();
  for (const matchers of Object.values(hooks)) {
    for (const matcher of matchers) {
      for (const hook of matcher.hooks) {
        if (!hook.command)
          continue;
        for (const match of hook.command.matchAll(/(?:\$\{(?:CLAUDE_PLUGIN_ROOT|CLAUDE_PROJECT_DIR)\}|\$(?:CLAUDE_PLUGIN_ROOT|CLAUDE_PROJECT_DIR))\/([^\s"'`;|&]+)/g))
          references.add(match[1]!);
        for (const match of hook.command.matchAll(/(?:^|[\s"'=])\.\/([^\s"'`;|&]+)/g))
          references.add(match[1]!);
      }
    }
  }
  return [...references].sort((a, b) => a.localeCompare(b, 'en'));
}

async function copyHookReference(
  sourceRoot: string,
  relativePath: string,
  outputRoot: string,
  items: MigrationItem[],
): Promise<void> {
  const source = path.resolve(sourceRoot, relativePath);
  const relation = path.relative(sourceRoot, source);
  if (relation === '..' || relation.startsWith(`..${path.sep}`) || path.isAbsolute(relation)) {
    items.push({
      kind: 'hook-file', id: relativePath, outcome: 'unmapped',
      message: 'Referenced Hook file escapes the source project and was not copied.',
    });
    return;
  }
  let stat: import('node:fs').Stats;
  try {
    stat = await fs.lstat(source);
  } catch {
    items.push({
      kind: 'hook-file', id: relativePath, outcome: 'unmapped',
      source: relation.split(path.sep).join('/'),
      message: 'Referenced Hook file does not exist and requires manual recovery.',
    });
    return;
  }
  if (stat.isSymbolicLink()) {
    items.push({
      kind: 'hook-file', id: relativePath, outcome: 'unmapped',
      source: relation.split(path.sep).join('/'),
      message: 'Referenced Hook symlinks are not copied.',
    });
    return;
  }
  if (stat.isDirectory()) {
    const entries = await fs.readdir(source, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name, 'en')))
      await copyHookReference(sourceRoot, path.join(relativePath, entry.name), outputRoot, items);
    return;
  }
  if (!stat.isFile())
    return;
  const normalized = relation.split(path.sep).join('/');
  const destination = `.acplugin-migration/unmapped/hook-files/${normalized}`;
  const output = path.join(outputRoot, destination);
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.copyFile(source, output);
  items.push({
    kind: 'hook-file', id: normalized, outcome: 'unmapped',
    source: normalized, destination,
    message: 'Referenced Hook implementation was preserved for manual typed migration.',
  });
}

async function metadataFor(scan: ScanResult, options: MigrationOptions): Promise<{ name: string; version: string; description: string; displayName?: string }> {
  const plugin = 'meta' in scan ? scan as PluginScanResult : undefined;
  let name = options.name ?? plugin?.meta.name;
  let description = options.description ?? plugin?.meta.description;
  if (!name && process.stdin.isTTY)
    name = await input({ message: 'Plugin name', default: safeId(path.basename(scan.rootDir)) });
  if (!description && process.stdin.isTTY)
    description = await input({ message: 'Plugin description' });
  if (!name || !description)
    throw new Error('Migration requires plugin name and description; pass --name and --description in non-interactive mode.');
  if (!ID_PATTERN.test(name))
    throw new Error('Migration plugin name must be lowercase kebab-case.');
  return {
    name,
    version: plugin?.meta.version && /^\d+\.\d+\.\d+/.test(plugin.meta.version) ? plugin.meta.version : '0.1.0',
    description,
    ...(plugin?.meta.displayName ? { displayName: plugin.meta.displayName } : {}),
  };
}

async function writeCanonicalProject(
  scan: ScanResult,
  outputRoot: string,
  options: MigrationOptions,
): Promise<{ items: MigrationItem[]; diagnostics: readonly Diagnostic[] }> {
  const metadata = await metadataFor(scan, options);
  const items: MigrationItem[] = [];
  const writes: Promise<void>[] = [];
  for (const skill of scan.skills)
    writes.push(...migrateSkill(skill, scan.rootDir, outputRoot, items));
  for (const command of scan.commands)
    writes.push(migrateCommand(command, scan.rootDir, outputRoot, items));
  for (const agent of scan.agents)
    writes.push(migrateAgent(agent, scan.rootDir, outputRoot, items));
  await Promise.all(writes);

  for (const [index, instruction] of scan.instructions.entries()) {
    const destination = await unmapped(outputRoot, 'instructions', `${index}-${instruction.fileName}`, instruction.content);
    items.push({ kind: 'instruction', id: instruction.fileName, outcome: 'unmapped', source: relative(scan.rootDir, instruction.sourcePath), destination, message: 'Instructions are outside the installable plugin boundary.' });
  }

  let usesMcp = false;
  for (const server of scan.mcp?.servers ?? []) {
    const id = safeId(server.name);
    const source = remoteMcpSource(server);
    if (source) {
      const destination = `src/mcp/${id}/mcp.ts`;
      await copyText(path.join(outputRoot, destination), source);
      items.push({ kind: 'mcp', id, outcome: 'migrated', source: relative(scan.rootDir, scan.mcp!.sourcePath), destination });
      usesMcp = true;
    } else {
      const destination = await unmapped(outputRoot, 'mcp', `${id}.json`, stableJson({ [server.name]: redactedMcpServer(server) }));
      items.push({ kind: 'mcp', id, outcome: 'unmapped', source: relative(scan.rootDir, scan.mcp!.sourcePath), destination, message: 'Local command or unsupported transport MCP requires a complete canonical implementation.' });
    }
  }

  if (scan.hooks) {
    const destination = await unmapped(outputRoot, 'hooks', 'hooks.json', stableJson({ hooks: scan.hooks }));
    items.push({ kind: 'hooks', id: 'hooks', outcome: 'unmapped', destination, message: 'Raw legacy Hooks require manual typed handler migration.' });
    for (const reference of hookReferenceCandidates(scan.hooks))
      await copyHookReference(scan.rootDir, reference, outputRoot, items);
  }

  for (const file of scan.pluginFiles) {
    const destination = await unmapped(outputRoot, 'plugin-files', file.relativePath, file.content);
    items.push({ kind: 'plugin-file', id: file.relativePath, outcome: 'unmapped', destination, message: 'Unclassified plugin files are not published automatically.' });
  }

  const imports = [`import { defineConfig } from '@tokenroll/acplugin';`];
  if (usesMcp)
    imports.push(`import mcp from '@tokenroll/acplugin-module-mcp';`);
  await copyText(path.join(outputRoot, 'acplugin.config.ts'), `${imports.join('\n')}

export default defineConfig({
  name: ${JSON.stringify(metadata.name)},
  version: ${JSON.stringify(metadata.version)},
  description: ${JSON.stringify(metadata.description)},${metadata.displayName
    ? `
  displayName: ${JSON.stringify(metadata.displayName)},`
    : ''}${usesMcp
    ? `
  modules: [mcp()],`
    : ''}
});
`);
  const devDependencies: Record<string, string> = { '@tokenroll/acplugin': '^1.0.0', 'typescript': '^5.9.3', '@types/node': '^20.19.0' };
  if (usesMcp)
    devDependencies['@tokenroll/acplugin-module-mcp'] = '^1.0.0';
  await copyText(path.join(outputRoot, 'package.json'), stableJson({
    name: metadata.name,
    version: metadata.version,
    private: true,
    type: 'module',
    packageManager: 'pnpm@10.34.5',
    scripts: { validate: 'acplugin validate', inspect: 'acplugin inspect', build: 'acplugin build', typecheck: 'tsc --noEmit' },
    devDependencies,
  }));
  await copyText(path.join(outputRoot, 'tsconfig.json'), stableJson({ compilerOptions: { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, noEmit: true, types: ['node'], skipLibCheck: true }, include: ['acplugin.config.ts', 'src/**/*.ts'] }));
  await copyText(path.join(outputRoot, '.gitignore'), 'node_modules\ndist\n');

  const resolved = resolveConfig({
    ...metadata,
    ...(usesMcp ? { modules: [{ name: '@tokenroll/acplugin-module-mcp' }] } : {}),
  }, path.join(outputRoot, 'acplugin.config.ts'), 'validate', 'production');
  if (!resolved.config)
    return { items, diagnostics: resolved.diagnostics };
  const scanned = await scanProject(resolved.config);
  return { items, diagnostics: scanned.diagnostics.diagnostics };
}

async function assertDestination(sourceRoot: string, destination: string): Promise<void> {
  if (await exists(destination))
    throw new Error('Migration destination must not exist.');
  const relation = path.relative(sourceRoot, destination);
  if (relation === '' || (!path.isAbsolute(relation) && relation !== '..' && !relation.startsWith(`..${path.sep}`)))
    throw new Error('Migration destination must be outside the source tree.');
}

export async function migrate(options: MigrationOptions): Promise<MigrationReport> {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  let sourceRoot: string;
  let cleanup: (() => void) | undefined;
  if (isGitHubSource(options.source) && !await exists(path.resolve(cwd, options.source))) {
    const source = parseGitHubSource(options.source);
    if (options.subPath)
      source.subPath = options.subPath;
    sourceRoot = await downloadGitHubRepo(source);
    const temporaryRoot = getTempRoot(sourceRoot);
    cleanup = () => cleanupTempDir(temporaryRoot);
  } else {
    sourceRoot = path.resolve(cwd, options.source);
  }

  try {
    if (await exists(path.join(sourceRoot, 'acplugin.config.ts')))
      throw new Error('Source is already a canonical acplugin project.');
    const destination = path.resolve(cwd, options.destination ?? `${path.basename(sourceRoot)}-acplugin`);
    await assertDestination(sourceRoot, destination);
    const stageParent = options.dryRun ? os.tmpdir() : path.dirname(destination);
    if (!options.dryRun)
      await fs.mkdir(stageParent, { recursive: true });
    const stage = await fs.mkdtemp(path.join(stageParent, `.${path.basename(destination)}.migration-`));
    let sourceType: MigrationReport['sourceType'];
    const projects: string[] = [];
    const items: MigrationItem[] = [];
    const diagnostics: Diagnostic[] = [];
    try {
      if (hasMarketplace(sourceRoot)) {
        sourceType = 'marketplace';
        const plugins = scanAllPlugins(sourceRoot);
        const selected = options.all ? plugins : plugins.filter(plugin => plugin.meta.name === options.plugin);
        if (selected.length === 0)
          throw new Error('Marketplace migration requires --plugin <name> or --all.');
        for (const plugin of selected) {
          const id = safeId(plugin.meta.name);
          const projectRoot = path.join(stage, id);
          const result = await writeCanonicalProject(plugin, projectRoot, options);
          items.push(...result.items.map(item => ({ ...item, destination: item.destination ? `${id}/${item.destination}` : undefined })));
          diagnostics.push(...result.diagnostics);
          projects.push(id);
        }
        await copyText(path.join(stage, 'pnpm-workspace.yaml'), `packages:\n${projects.map(project => `  - ${project}`).join('\n')}\n`);
      } else {
        sourceType = isSinglePlugin(sourceRoot) ? 'plugin' : 'project';
        const scan = sourceType === 'plugin' ? scanPlugin(sourceRoot) : scanClaudeProject(sourceRoot);
        const result = await writeCanonicalProject(scan, stage, options);
        items.push(...result.items);
        diagnostics.push(...result.diagnostics);
        projects.push('.');
      }
      const hasLoss = items.some(item => item.outcome === 'degraded' || item.outcome === 'unmapped');
      const success = !diagnostics.some(diagnostic => diagnostic.severity === 'error') && !(options.strict && hasLoss);
      const report: MigrationReport = {
        schemaVersion: '1', sourceType, projects, items, diagnostics,
        success, dryRun: options.dryRun ?? false,
      };
      await copyText(path.join(stage, '.acplugin-migration/report.json'), stableJson(report));
      if (success && !options.dryRun)
        await fs.rename(stage, destination);
      else
        await fs.rm(stage, { recursive: true, force: true });
      return report;
    } catch (error) {
      await fs.rm(stage, { recursive: true, force: true });
      throw error;
    }
  } finally {
    cleanup?.();
  }
}
