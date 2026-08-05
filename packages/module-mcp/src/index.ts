import { promises as fs } from 'node:fs';
import path from 'node:path';
import { build as rolldownBuild, type OutputChunk } from 'rolldown';
import {
  bytesArtifact,
  stableJson,
  type AcpluginModule,
  type ArtifactInput,
  type ModuleBuildContext,
  type ModuleDiscoverContext,
  type ModuleGenerateContext,
  type ModuleValidateContext,
  type TargetContribution,
} from '@tokenroll/acplugin';

export const MCP_MODULE_NAME = '@tokenroll/acplugin-module-mcp';

export type ValueSource = { value: string } | { env: string };

interface McpServerBase {
  readonly __acpluginMcpServer: true;
}

export interface HttpMcpServer extends McpServerBase {
  transport: 'http';
  url: string;
  auth?:
    | { type: 'none' }
    | { type: 'oauth'; scopes?: readonly string[] }
    | { type: 'bearer'; env: string };
  headers?: Readonly<Record<string, ValueSource>>;
}

export interface StdioMcpServer extends McpServerBase {
  transport: 'stdio';
  entry?: string;
  env?: Readonly<Record<string, ValueSource>>;
}

export type McpServerDefinition = HttpMcpServer | StdioMcpServer;
export type McpServerInput = Omit<HttpMcpServer, '__acpluginMcpServer'> | Omit<StdioMcpServer, '__acpluginMcpServer'>;

export function defineMcpServer(definition: McpServerInput): McpServerDefinition {
  return Object.freeze({ ...definition, __acpluginMcpServer: true }) as McpServerDefinition;
}

interface DiscoveredMcpServer {
  id: string;
  directory: string;
  descriptorPath: string;
  definition: McpServerDefinition;
}

interface BuiltMcpState {
  bundles: ReadonlyMap<string, BundledServer>;
}

interface BundledServer {
  server: string;
  licenses?: string;
}

const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ENV_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

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

async function discover(context: ModuleDiscoverContext): Promise<DiscoveredMcpServer[]> {
  const root = path.join(context.config.srcDir, 'mcp');
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return [];
    throw error;
  }

  const result: DiscoveredMcpServer[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
    const directory = path.join(root, entry.name);
    if (!entry.isDirectory() || !ID_PATTERN.test(entry.name)) {
      context.diagnostics.error('MCP_ENTRY_INVALID', 'MCP entries must be one-level lowercase kebab-case directories.', {
        phase: 'discover', module: MCP_MODULE_NAME,
        location: { path: path.relative(context.config.root, directory).split(path.sep).join('/') },
      });
      continue;
    }
    const descriptorPath = path.join(directory, 'mcp.ts');
    try {
      const definition = unwrapDefault(await context.loadTypeScriptModule(descriptorPath));
      if (!definition || typeof definition !== 'object' || (definition as { __acpluginMcpServer?: boolean }).__acpluginMcpServer !== true)
        throw new Error('mcp.ts must default-export defineMcpServer(...).');
      result.push({ id: entry.name, directory, descriptorPath, definition: definition as McpServerDefinition });
    } catch {
      context.diagnostics.error('MCP_DESCRIPTOR_LOAD_FAILED', `MCP ${entry.name} descriptor could not be loaded.`, {
        phase: 'discover', module: MCP_MODULE_NAME,
        location: { path: path.relative(context.config.root, descriptorPath).split(path.sep).join('/') },
      });
    }
  }
  return result;
}

function validateValueSources(
  values: Readonly<Record<string, ValueSource>> | undefined,
  server: DiscoveredMcpServer,
  context: ModuleValidateContext,
): void {
  for (const [name, source] of Object.entries(values ?? {})) {
    if (!name || !source || typeof source !== 'object' || (('value' in source) === ('env' in source))) {
      context.diagnostics.error('MCP_VALUE_SOURCE_INVALID', `MCP value ${name || '<empty>'} must contain exactly one of value or env.`, {
        phase: 'validate', module: MCP_MODULE_NAME,
        location: { path: path.relative(context.config.root, server.descriptorPath).split(path.sep).join('/') },
      });
      continue;
    }
    if ('value' in source && typeof source.value !== 'string')
      context.diagnostics.error('MCP_LITERAL_INVALID', `${name} literal must be a string.`, { phase: 'validate', module: MCP_MODULE_NAME });
    if ('env' in source && !ENV_PATTERN.test(source.env))
      context.diagnostics.error('MCP_ENV_INVALID', `${name} environment name is invalid.`, { phase: 'validate', module: MCP_MODULE_NAME });
  }
}

async function validate(context: ModuleValidateContext, servers: DiscoveredMcpServer[]): Promise<void> {
  for (const server of servers) {
    const definition = server.definition;
    if (definition.transport === 'http') {
      let url: URL | undefined;
      try {
        url = new URL(definition.url);
      } catch {
        context.diagnostics.error('MCP_URL_INVALID', `MCP server ${server.id} has an invalid URL.`, { phase: 'validate', module: MCP_MODULE_NAME });
      }
      if (url && context.config.mode === 'production' && url.protocol !== 'https:')
        context.diagnostics.error('MCP_HTTPS_REQUIRED', `MCP server ${server.id} must use HTTPS in production.`, { phase: 'validate', module: MCP_MODULE_NAME });
      if (url && context.config.mode === 'development' && url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '::1'].includes(url.hostname)))
        context.diagnostics.error('MCP_HTTP_LOOPBACK_ONLY', `MCP server ${server.id} may use HTTP only on loopback in development.`, { phase: 'validate', module: MCP_MODULE_NAME });
      if (definition.auth?.type === 'bearer' && !ENV_PATTERN.test(definition.auth.env))
        context.diagnostics.error('MCP_ENV_INVALID', `MCP server ${server.id} bearer environment name is invalid.`, { phase: 'validate', module: MCP_MODULE_NAME });
      if (definition.auth?.type === 'oauth' && definition.auth.scopes?.some(scope => typeof scope !== 'string' || scope === ''))
        context.diagnostics.error('MCP_OAUTH_SCOPE_INVALID', `MCP server ${server.id} OAuth scopes must be non-empty strings.`, { phase: 'validate', module: MCP_MODULE_NAME });
      validateValueSources(definition.headers, server, context);
    } else if (definition.transport === 'stdio') {
      const entry = path.resolve(server.directory, definition.entry ?? 'server.ts');
      const relative = path.relative(server.directory, entry);
      if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
        context.diagnostics.error('MCP_ENTRY_ESCAPE', `MCP server ${server.id} entry must stay inside its directory.`, { phase: 'validate', module: MCP_MODULE_NAME });
      try {
        const stat = await fs.lstat(entry);
        if (!stat.isFile() || stat.isSymbolicLink())
          throw new Error('entry is not a regular file');
      } catch {
        context.diagnostics.error('MCP_ENTRY_MISSING', `MCP server ${server.id} entry cannot be used.`, { phase: 'validate', module: MCP_MODULE_NAME });
      }
      validateValueSources(definition.env, server, context);
    } else {
      context.diagnostics.error('MCP_TRANSPORT_UNSUPPORTED', `MCP server ${server.id} transport is unsupported.`, { phase: 'validate', module: MCP_MODULE_NAME });
    }
  }
}

async function bundleServer(entry: string, outputFile: string): Promise<BundledServer> {
  const output = await rolldownBuild({
    input: entry,
    platform: 'node',
    external: [/^node:/],
    write: false,
    output: {
      format: 'esm',
      sourcemap: false,
      codeSplitting: false,
      comments: { legal: true },
    },
  });
  const chunks = output.output.filter((item): item is OutputChunk => item.type === 'chunk');
  const assets = output.output.filter(item => item.type === 'asset');
  if (chunks.length !== 1 || assets.length !== 0)
    throw new Error('Local MCP server must bundle to exactly one JavaScript chunk and no assets.');
  await fs.mkdir(path.dirname(outputFile), { recursive: true });
  await fs.writeFile(outputFile, chunks[0]!.code);
  const licenses = await writeThirdPartyLicenses(chunks[0]!, path.dirname(outputFile));
  return licenses ? { server: outputFile, licenses } : { server: outputFile };
}

async function build(context: ModuleBuildContext, servers: DiscoveredMcpServer[]): Promise<BuiltMcpState> {
  const bundles = new Map<string, BundledServer>();
  for (const server of servers) {
    if (server.definition.transport !== 'stdio')
      continue;
    const entry = path.resolve(server.directory, server.definition.entry ?? 'server.ts');
    const output = path.join(context.workDir, server.id, 'server.mjs');
    bundles.set(server.id, await bundleServer(entry, output));
  }
  return { bundles };
}

function mapValues(values: Readonly<Record<string, ValueSource>> | undefined): {
  literal: Record<string, string>;
  environment: Record<string, string>;
} {
  const literal: Record<string, string> = {};
  const environment: Record<string, string> = {};
  for (const [name, source] of Object.entries(values ?? {}).sort(([a], [b]) => a.localeCompare(b, 'en'))) {
    if ('value' in source)
      literal[name] = source.value;
    else
      environment[name] = source.env;
  }
  return { literal, environment };
}

function claudeDescriptor(server: DiscoveredMcpServer): Record<string, unknown> {
  const definition = server.definition;
  if (definition.transport === 'stdio') {
    const values = mapValues(definition.env);
    return {
      type: 'stdio',
      command: 'node',
      args: [`\${CLAUDE_PLUGIN_ROOT}/mcp/${server.id}/server.mjs`],
      env: {
        ...values.literal,
        ...Object.fromEntries(Object.entries(values.environment).map(([name, env]) => [name, `\${${env}}`])),
      },
    };
  }
  const values = mapValues(definition.headers);
  const headers: Record<string, string> = {
    ...values.literal,
    ...Object.fromEntries(Object.entries(values.environment).map(([name, env]) => [name, `\${${env}}`])),
  };
  if (definition.auth?.type === 'bearer')
    headers.Authorization = `Bearer \${${definition.auth.env}}`;
  return {
    type: 'http',
    url: definition.url,
    ...(Object.keys(headers).length === 0 ? {} : { headers }),
    ...(definition.auth?.type === 'oauth' && definition.auth.scopes?.length
      ? { oauth: { scopes: definition.auth.scopes.join(' ') } }
      : {}),
  };
}

function codexDescriptor(server: DiscoveredMcpServer): Record<string, unknown> {
  const definition = server.definition;
  if (definition.transport === 'stdio') {
    const values = mapValues(definition.env);
    return {
      command: 'node',
      args: [`./mcp/${server.id}/server.mjs`],
      cwd: '.',
      ...(Object.keys(values.literal).length === 0 ? {} : { env: values.literal }),
      ...(Object.keys(values.environment).length === 0 ? {} : { env_vars: Object.values(values.environment).sort() }),
    };
  }
  const values = mapValues(definition.headers);
  return {
    url: definition.url,
    ...(definition.auth?.type === 'bearer' ? { bearer_token_env_var: definition.auth.env } : {}),
    ...(definition.auth?.type === 'oauth' && definition.auth.scopes?.length ? { scopes: definition.auth.scopes } : {}),
    ...(Object.keys(values.literal).length === 0 ? {} : { http_headers: values.literal }),
    ...(Object.keys(values.environment).length === 0 ? {} : { env_http_headers: values.environment }),
  };
}

async function generate(
  context: ModuleGenerateContext,
  servers: DiscoveredMcpServer[],
  built: BuiltMcpState,
): Promise<TargetContribution> {
  if (servers.length === 0)
    return {};
  const artifacts: ArtifactInput[] = [];
  for (const [id, bundle] of built.bundles) {
    artifacts.push({ path: `mcp/${id}/server.mjs`, source: { type: 'file', path: bundle.server }, mode: 0o755 });
    if (bundle.licenses)
      artifacts.push({ path: `mcp/${id}/THIRD_PARTY_LICENSES.txt`, source: { type: 'file', path: bundle.licenses }, mode: 0o644 });
  }

  if (context.target === 'claude-code') {
    const mcpServers = Object.fromEntries(servers.map(server => [server.id, claudeDescriptor(server)]));
    artifacts.push(bytesArtifact('.mcp.json', stableJson({ mcpServers })));
    return { artifacts };
  }

  const serverMap = Object.fromEntries(servers.map(server => [server.id, codexDescriptor(server)]));
  artifacts.push(bytesArtifact('.mcp.json', stableJson(serverMap)));
  return { artifacts, manifestFields: { mcpServers: './.mcp.json' } };
}

export function mcp(): AcpluginModule<DiscoveredMcpServer[], BuiltMcpState> {
  return {
    name: MCP_MODULE_NAME,
    discover,
    validate,
    build,
    generate,
  };
}

export default mcp;
