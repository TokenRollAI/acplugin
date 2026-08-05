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

/** MCP 官方 Module 的稳定名称，也是诊断和配置依赖使用的唯一 ID。 */
export const MCP_MODULE_NAME = '@tokenroll/acplugin-module-mcp';

/** MCP Header 或环境字段的字面量来源与运行时环境变量来源。 */
export type ValueSource = { value: string } | { env: string };

/** 由 defineMcpServer 注入、供 discover 阶段验证定义来源的品牌字段。 */
interface McpServerBase {
  /** 标识定义已通过官方辅助函数构造。 */
  readonly __acpluginMcpServer: true;
}

/** 只声明远程端点、不需要用户提供服务端实现的 HTTP MCP Server。 */
export interface HttpMcpServer extends McpServerBase {
  /** 固定为 HTTP 远程传输。 */
  transport: 'http';
  /** MCP Server 的完整 URL。 */
  url: string;
  /** 无认证、OAuth 或从环境变量读取 Bearer Token 的认证策略。 */
  auth?:
    | { type: 'none' }
    | { type: 'oauth'; scopes?: readonly string[] }
    | { type: 'bearer'; env: string };
  /** 附加到 HTTP 请求的字面量或环境变量 Header。 */
  headers?: Readonly<Record<string, ValueSource>>;
}

/** 由项目提供完整本地实现、构建为独立 Node 进程的 stdio MCP Server。 */
export interface StdioMcpServer extends McpServerBase {
  /** 固定为 stdio 本地传输。 */
  transport: 'stdio';
  /** 相对于当前 MCP 目录的入口，默认 `server.ts`。 */
  entry?: string;
  /** 传递给本地进程的字面量或宿主环境变量。 */
  env?: Readonly<Record<string, ValueSource>>;
}

/** 远程 HTTP 声明与本地 stdio 实现组成的 MCP Server 联合类型。 */
export type McpServerDefinition = HttpMcpServer | StdioMcpServer;
/** 配置作者提供的 MCP 定义，不包含框架品牌字段。 */
export type McpServerInput = Omit<HttpMcpServer, '__acpluginMcpServer'> | Omit<StdioMcpServer, '__acpluginMcpServer'>;

/**
 * 为 MCP 定义提供类型推断，并注入 discover 阶段使用的不可变品牌字段。
 *
 * @param definition HTTP 远程声明或 stdio 本地实现配置。
 * @returns 冻结后的完整 McpServerDefinition。
 */
export function defineMcpServer(definition: McpServerInput): McpServerDefinition {
  return Object.freeze({ ...definition, __acpluginMcpServer: true }) as McpServerDefinition;
}

/** discover 阶段保存的 MCP 描述、目录与已执行定义。 */
interface DiscoveredMcpServer {
  /** 从一级目录名称取得的 MCP Server ID。 */
  id: string;
  /** 当前 MCP Server 的绝对源码目录。 */
  directory: string;
  /** `mcp.ts` 描述文件的绝对路径。 */
  descriptorPath: string;
  /** TypeScript 描述文件执行后得到的 Server 定义。 */
  definition: McpServerDefinition;
}

/** build 阶段向 generate 阶段传递的本地 stdio Server Bundle。 */
interface BuiltMcpState {
  /** 仅包含需要本地构建的 stdio Server。 */
  bundles: ReadonlyMap<string, BundledServer>;
}

/** 单个 stdio MCP Server 的独立可执行文件与许可文件。 */
interface BundledServer {
  /** Rolldown 生成的单文件 ESM Server 路径。 */
  server: string;
  /** Bundle 包含第三方依赖时生成的合并许可文件。 */
  licenses?: string;
}

/** MCP 一级目录接受的小写 kebab-case 格式。 */
const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** MCP 环境变量引用接受的可移植名称格式。 */
const ENV_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

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
 * @param directory Server Bundle 所在目录。
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
  /** 与 Server 一同发布的第三方许可文件路径。 */
  const destination = path.join(directory, 'THIRD_PARTY_LICENSES.txt');
  await fs.writeFile(destination, `${sections.join('\n\n')}\n`);
  return destination;
}

/**
 * 扫描 `src/mcp/<id>/mcp.ts` 并执行带品牌校验的 TypeScript 定义。
 *
 * @param context Core 提供的 discover 上下文与 TypeScript 加载器。
 * @returns 按 Server ID 稳定排序的有效定义。
 */
async function discover(context: ModuleDiscoverContext): Promise<DiscoveredMcpServer[]> {
  /** MCP Module 拥有的固定源码根目录。 */
  const root = path.join(context.config.srcDir, 'mcp');
  /** MCP 根目录的一级目录项。 */
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return [];
    throw error;
  }

  /** 成功加载并通过品牌校验的 MCP Server。 */
  const result: DiscoveredMcpServer[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
    /** 当前 MCP Server 候选目录的绝对路径。 */
    const directory = path.join(root, entry.name);
    if (!entry.isDirectory() || !ID_PATTERN.test(entry.name)) {
      context.diagnostics.error('MCP_ENTRY_INVALID', 'MCP entries must be one-level lowercase kebab-case directories.', {
        phase: 'discover', module: MCP_MODULE_NAME,
        location: { path: path.relative(context.config.root, directory).split(path.sep).join('/') },
      });
      continue;
    }
    /** 当前 Server 必需的 TypeScript 描述文件。 */
    const descriptorPath = path.join(directory, 'mcp.ts');
    try {
      /** Jiti 执行并解包后的 MCP 定义候选值。 */
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

/**
 * 验证 Header 或环境映射中的每个值只使用字面量和环境变量之一。
 *
 * @param values 待验证的名称到 ValueSource 映射。
 * @param server 当前 MCP Server，用于诊断定位。
 * @param context Core 提供的验证与诊断上下文。
 */
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

/**
 * 验证远程 HTTP 安全策略或本地 stdio 入口与环境变量约束。
 *
 * production 强制 HTTPS；development 仅允许 HTTPS 或 loopback HTTP。本地入口必须留在
 * 自己的 MCP 目录中，并且是普通非符号链接文件。
 *
 * @param context Core 提供的项目、模式与诊断上下文。
 * @param servers discover 阶段成功加载的 MCP Server。
 */
async function validate(context: ModuleValidateContext, servers: DiscoveredMcpServer[]): Promise<void> {
  for (const server of servers) {
    /** 当前 Server 已加载但尚未完成语义校验的定义。 */
    const definition = server.definition;
    if (definition.transport === 'http') {
      /** 成功解析时的标准 URL，用于协议和主机安全检查。 */
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
      /** 默认或显式配置解析出的本地 Server 绝对入口。 */
      const entry = path.resolve(server.directory, definition.entry ?? 'server.ts');
      /** 用于发现目录逃逸的入口相对路径。 */
      const relative = path.relative(server.directory, entry);
      if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
        context.diagnostics.error('MCP_ENTRY_ESCAPE', `MCP server ${server.id} entry must stay inside its directory.`, { phase: 'validate', module: MCP_MODULE_NAME });
      try {
        /** 用 lstat 获取且用于拒绝符号链接的入口元数据。 */
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

/**
 * 将完整本地 MCP 实现打包为单文件 Node ESM，并收集第三方许可。
 *
 * @param entry 用户提供的本地 Server TypeScript 入口。
 * @param outputFile Module 工作目录中的目标 Bundle 路径。
 * @returns 可由 generate 阶段贡献的 Server 与可选许可文件。
 */
async function bundleServer(entry: string, outputFile: string): Promise<BundledServer> {
  /** 保留 Node 内置模块为 external 的内存构建结果。 */
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
  /** 构建产生的 JavaScript Chunk；协议要求严格只有一个。 */
  const chunks = output.output.filter((item): item is OutputChunk => item.type === 'chunk');
  /** 本地 MCP 暂不支持需要额外复制的 Rolldown Asset。 */
  const assets = output.output.filter(item => item.type === 'asset');
  if (chunks.length !== 1 || assets.length !== 0)
    throw new Error('Local MCP server must bundle to exactly one JavaScript chunk and no assets.');
  await fs.mkdir(path.dirname(outputFile), { recursive: true });
  await fs.writeFile(outputFile, chunks[0]!.code);
  /** Bundle 包含第三方依赖时生成的许可汇总。 */
  const licenses = await writeThirdPartyLicenses(chunks[0]!, path.dirname(outputFile));
  return licenses ? { server: outputFile, licenses } : { server: outputFile };
}

/**
 * 只为 stdio 定义构建本地 Server；HTTP 定义保持纯远程声明。
 *
 * @param context Core 提供的 Module 工作目录。
 * @param servers 已通过验证的 MCP Server。
 * @returns 按 Server ID 索引的本地 Bundle 状态。
 */
async function build(context: ModuleBuildContext, servers: DiscoveredMcpServer[]): Promise<BuiltMcpState> {
  /** 仅包含 stdio Server 的 Bundle 索引。 */
  const bundles = new Map<string, BundledServer>();
  for (const server of servers) {
    if (server.definition.transport !== 'stdio')
      continue;
    /** 已在 validate 阶段确认留在 Server 目录内的本地入口。 */
    const entry = path.resolve(server.directory, server.definition.entry ?? 'server.ts');
    /** 当前 Server 在 Module 隔离工作目录中的 Bundle 路径。 */
    const output = path.join(context.workDir, server.id, 'server.mjs');
    bundles.set(server.id, await bundleServer(entry, output));
  }
  return { bundles };
}

/**
 * 将 ValueSource 映射拆分为字面量和环境变量引用，供平台分别编码。
 *
 * @param values Header 或进程环境配置。
 * @returns 按名称稳定插入的 literal 与 environment 映射。
 */
function mapValues(values: Readonly<Record<string, ValueSource>> | undefined): {
  literal: Record<string, string>;
  environment: Record<string, string>;
} {
  /** 可以直接写入目标清单的非敏感字面量。 */
  const literal: Record<string, string> = {};
  /** 只写变量名称、由安装运行时读取真实值的引用。 */
  const environment: Record<string, string> = {};
  for (const [name, source] of Object.entries(values ?? {}).sort(([a], [b]) => a.localeCompare(b, 'en'))) {
    if ('value' in source)
      literal[name] = source.value;
    else
      environment[name] = source.env;
  }
  return { literal, environment };
}

/**
 * 把规范 MCP 定义转换为 Claude Code `.mcp.json` Server 描述。
 *
 * @param server 已验证并可能完成本地构建的 MCP Server。
 * @returns Claude Code 使用的 stdio 或 HTTP 配置。
 */
function claudeDescriptor(server: DiscoveredMcpServer): Record<string, unknown> {
  /** 当前 Server 的可判别联合定义。 */
  const definition = server.definition;
  if (definition.transport === 'stdio') {
    /** 拆分后的进程环境字面量与宿主变量引用。 */
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
  /** 拆分后的 HTTP Header 字面量与宿主变量引用。 */
  const values = mapValues(definition.headers);
  /** 最终写入 Claude `.mcp.json` 的 Header。 */
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

/**
 * 把规范 MCP 定义转换为 Codex Plugin MCP Server 描述。
 *
 * @param server 已验证并可能完成本地构建的 MCP Server。
 * @returns Codex 使用的 stdio 或 HTTP 配置。
 */
function codexDescriptor(server: DiscoveredMcpServer): Record<string, unknown> {
  /** 当前 Server 的可判别联合定义。 */
  const definition = server.definition;
  if (definition.transport === 'stdio') {
    /** 拆分后的进程环境字面量与宿主变量引用。 */
    const values = mapValues(definition.env);
    return {
      command: 'node',
      args: [`./mcp/${server.id}/server.mjs`],
      cwd: '.',
      ...(Object.keys(values.literal).length === 0 ? {} : { env: values.literal }),
      ...(Object.keys(values.environment).length === 0 ? {} : { env_vars: Object.values(values.environment).sort() }),
    };
  }
  /** 拆分后的 HTTP Header 字面量与宿主变量引用。 */
  const values = mapValues(definition.headers);
  return {
    url: definition.url,
    ...(definition.auth?.type === 'bearer' ? { bearer_token_env_var: definition.auth.env } : {}),
    ...(definition.auth?.type === 'oauth' && definition.auth.scopes?.length ? { scopes: definition.auth.scopes } : {}),
    ...(Object.keys(values.literal).length === 0 ? {} : { http_headers: values.literal }),
    ...(Object.keys(values.environment).length === 0 ? {} : { env_http_headers: values.environment }),
  };
}

/**
 * 为当前目标贡献本地 Server Bundle、许可文件和平台 MCP 清单。
 *
 * @param context 当前目标的 generate 上下文。
 * @param servers discover 阶段得到的全部远程和本地 Server。
 * @param built build 阶段产生的 stdio Bundle 索引。
 * @returns 交给 Compiler 合并的 Artifact 和 Codex 清单扩展字段。
 */
async function generate(
  context: ModuleGenerateContext,
  servers: DiscoveredMcpServer[],
  built: BuiltMcpState,
): Promise<TargetContribution> {
  if (servers.length === 0)
    return {};
  /** 当前目标需要加入 ArtifactGraph 的 MCP 文件。 */
  const artifacts: ArtifactInput[] = [];
  for (const [id, bundle] of built.bundles) {
    artifacts.push({ path: `mcp/${id}/server.mjs`, source: { type: 'file', path: bundle.server }, mode: 0o755 });
    if (bundle.licenses)
      artifacts.push({ path: `mcp/${id}/THIRD_PARTY_LICENSES.txt`, source: { type: 'file', path: bundle.licenses }, mode: 0o644 });
  }

  if (context.target === 'claude-code') {
    /** Claude `.mcp.json` 要求包裹在 mcpServers 顶层字段中。 */
    const mcpServers = Object.fromEntries(servers.map(server => [server.id, claudeDescriptor(server)]));
    artifacts.push(bytesArtifact('.mcp.json', stableJson({ mcpServers })));
    return { artifacts };
  }

  /** Codex `.mcp.json` 使用 Server ID 到描述的直接映射。 */
  const serverMap = Object.fromEntries(servers.map(server => [server.id, codexDescriptor(server)]));
  artifacts.push(bytesArtifact('.mcp.json', stableJson(serverMap)));
  return { artifacts, manifestFields: { mcpServers: './.mcp.json' } };
}

/**
 * 创建参与 discover、validate、build 和 generate 阶段的官方 MCP Module。
 *
 * @returns 可直接加入 acplugin.config.ts modules 数组的 Module。
 */
export function mcp(): AcpluginModule<DiscoveredMcpServer[], BuiltMcpState> {
  return {
    name: MCP_MODULE_NAME,
    discover,
    validate,
    build,
    generate,
  };
}

/** 官方 MCP Module 工厂的默认导出。 */
export default mcp;
