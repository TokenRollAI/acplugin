import { promises as fs } from 'node:fs';
import path from 'node:path';
import type {
  ExtensionDiscoverContext,
  ExtensionValidateContext,
} from '@tokenroll/acplugin';
import { ENV_NAME_PATTERN, MCP_ID_PATTERN } from './constants.js';
import {
  isMcpServerDefinition,
  type McpServerDefinition,
  type ValueSource,
} from './types.js';

/** discover 阶段保存的 MCP 描述、目录与已执行定义。 */
export interface DiscoveredMcpServer {
  /** 从一级目录名称取得的 MCP Server ID。 */
  readonly id: string;
  /** 当前 MCP Server 的绝对源码目录。 */
  readonly directory: string;
  /** `mcp.ts` 描述文件的绝对路径。 */
  readonly descriptorPath: string;
  /** TypeScript 描述文件执行后得到的 Server 定义。 */
  readonly definition: McpServerDefinition;
}

/** 非空 discover 结果，作为 Core 判断 Extension 拥有实际资源的信号。 */
export interface DiscoveredMcpServers {
  /** 按 Server ID 稳定排序的发现结果。 */
  readonly servers: readonly DiscoveredMcpServer[];
}

/** HTTP MCP 定义允许出现的公开字段。 */
const HTTP_FIELDS = new Set(['transport', 'url', 'auth', 'headers']);

/** stdio MCP 定义允许出现的公开字段。 */
const STDIO_FIELDS = new Set(['transport', 'entry', 'env']);

/** MCP auth 定义允许出现的字段。 */
const AUTH_FIELDS = new Set(['type', 'env', 'scopes']);

/**
 * 兼容 TypeScript Loader 返回模块命名空间或已解包默认导出两种形态。
 *
 * @param value TypeScript 描述文件的加载结果。
 * @returns 存在 default 时返回 default，否则返回原值。
 */
function unwrapDefault(value: unknown): unknown {
  if (value !== null && typeof value === 'object' && 'default' in value)
    return (value as { readonly default: unknown }).default;
  return value;
}

/**
 * 把绝对描述文件路径转换为不泄露工程根的诊断位置。
 *
 * @param context 当前 discover 上下文。
 * @param sourcePath 需要报告的绝对来源路径。
 * @returns 以 srcDir 为基准且统一使用 POSIX 分隔符的位置。
 */
function sourceLocation(context: ExtensionDiscoverContext, sourcePath: string): string {
  /** 相对于规范源码根的安全报告路径。 */
  const relative = path.relative(context.srcDir, sourcePath).split(path.sep).join('/');
  return relative.startsWith('../') ? path.basename(sourcePath) : relative;
}

/**
 * 把 MCP 描述文件转换为相对于工程根的稳定诊断位置。
 *
 * @param context 当前 validate 上下文。
 * @param server 需要报告位置的 Server。
 * @returns 不包含宿主绝对目录的 POSIX 工程路径。
 */
function serverLocation(context: ExtensionValidateContext, server: DiscoveredMcpServer): string {
  return path.relative(context.project.root, server.descriptorPath).split(path.sep).join('/');
}

/**
 * 判断未知值是否为不带自定义原型的普通对象。
 *
 * @param value 待验证的作者配置值。
 * @returns 值可安全按自有字段读取时返回 true。
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    return false;
  /** 候选对象的原型，用于拒绝类实例和其他可执行访问器容器。 */
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * 扫描并加载 `src/mcp/<id>/mcp.ts` 作者格式。
 *
 * @param context Core 提供的隔离工作目录、源码根和 TypeScript Loader。
 * @param include 可选的显式 Server ID 白名单。
 * @returns 没有选中资源时返回 undefined，否则返回稳定发现状态。
 */
export async function discoverMcpServers(
  context: ExtensionDiscoverContext,
  include?: ReadonlySet<string>,
): Promise<DiscoveredMcpServers | undefined> {
  /** MCP Extension 独占的固定作者源码根。 */
  const root = path.join(context.srcDir, 'mcp');
  /** MCP 根目录中的一级目录项。 */
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch /** error 保存当前目录读取失败，供 ENOENT 分支判断。 */ (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return undefined;
    throw error;
  }

  /** 成功加载并通过品牌检查的 MCP Server 定义。 */
  const servers: DiscoveredMcpServer[] = [];
  /** include 中已经在源码目录找到的 Server ID。 */
  const includedIds = new Set<string>();
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name, 'en'))) {
    /** 当前 MCP Server 候选目录的绝对路径。 */
    const directory = path.join(root, entry.name);
    if (!entry.isDirectory() || !MCP_ID_PATTERN.test(entry.name)) {
      context.reportDiagnostic({
        code: 'MCP_ENTRY_INVALID',
        severity: 'error',
        message: 'MCP entries must be one-level lowercase kebab-case directories.',
        location: { path: sourceLocation(context, directory) },
      });
      continue;
    }
    if (include !== undefined && !include.has(entry.name))
      continue;
    includedIds.add(entry.name);
    /** 当前 MCP Server 必需的 TypeScript 描述文件。 */
    const descriptorPath = path.join(directory, 'mcp.ts');
    try {
      /** Loader 执行并解包后的 MCP 定义候选值。 */
      const definition = unwrapDefault(await context.loadTypeScriptModule(descriptorPath));
      if (!isMcpServerDefinition(definition))
        throw new TypeError('MCP descriptor must use defineMcpServer().');
      servers.push(Object.freeze({ id: entry.name, directory, descriptorPath, definition }));
    } catch {
      context.reportDiagnostic({
        code: 'MCP_DESCRIPTOR_LOAD_FAILED',
        severity: 'error',
        message: `MCP Server "${entry.name}" descriptor could not be loaded or was not created by defineMcpServer().`,
        location: { path: sourceLocation(context, descriptorPath) },
      });
    }
  }

  if (include !== undefined) {
    /** id 表示当前显式 include 项，用于报告不存在的作者资源。 */
    for (const id of include) {
      if (!includedIds.has(id)) {
        context.reportDiagnostic({
          code: 'MCP_INCLUDE_MISSING',
          severity: 'error',
          message: `Included MCP Server "${id}" does not exist under src/mcp.`,
          location: { path: `mcp/${id}` },
        });
      }
    }
  }

  /** 目录完全为空或 include 明确没有选择资源时不激活 Extension。 */
  const hasSelectedResource = servers.length > 0 || includedIds.size > 0;
  return hasSelectedResource ? Object.freeze({ servers: Object.freeze(servers) }) : undefined;
}

/**
 * 校验 Header 或环境映射中的每个值只使用字面量和环境变量之一。
 *
 * @param context Core 提供的诊断出口。
 * @param server 当前 MCP Server。
 * @param values 待验证的名称到 ValueSource 映射。
 * @param fieldPath 映射所在的稳定字段路径。
 */
function validateValueSources(
  context: ExtensionValidateContext,
  server: DiscoveredMcpServer,
  values: Readonly<Record<string, ValueSource>> | undefined,
  fieldPath: readonly string[],
): void {
  if (values === undefined)
    return;
  if (!isPlainObject(values)) {
    context.reportDiagnostic({
      code: 'MCP_VALUE_MAP_INVALID', severity: 'error', message: 'MCP value mappings must be plain objects.',
      location: { path: serverLocation(context, server) }, fieldPath,
    });
    return;
  }
  /** [name, source] 表示当前 Header 或环境变量映射。 */
  for (const [name, source] of Object.entries(values)) {
    /** 当前 ValueSource 的精确诊断路径。 */
    const valuePath = [...fieldPath, name];
    if (name.trim().length === 0 || !isPlainObject(source)
      || Object.keys(source).some(field => field !== 'value' && field !== 'env')
      || (Object.hasOwn(source, 'value') === Object.hasOwn(source, 'env'))) {
      context.reportDiagnostic({
        code: 'MCP_VALUE_SOURCE_INVALID', severity: 'error',
        message: `MCP value "${name || '<empty>'}" must contain exactly one of value or env.`,
        location: { path: serverLocation(context, server) }, fieldPath: valuePath,
      });
      continue;
    }
    if ('value' in source && typeof source.value !== 'string') {
      context.reportDiagnostic({
        code: 'MCP_LITERAL_INVALID', severity: 'error', message: `MCP value "${name}" literal must be a string.`,
        location: { path: serverLocation(context, server) }, fieldPath: [...valuePath, 'value'],
      });
    }
    if ('env' in source && (typeof source.env !== 'string' || !ENV_NAME_PATTERN.test(source.env))) {
      context.reportDiagnostic({
        code: 'MCP_ENV_INVALID', severity: 'error', message: `MCP value "${name}" environment name is invalid.`,
        location: { path: serverLocation(context, server) }, fieldPath: [...valuePath, 'env'],
      });
    }
  }
}

/**
 * 校验 HTTP Server 的 URL、认证、Header 和未知字段。
 *
 * @param context Core 提供的构建模式和诊断出口。
 * @param server 当前远程 MCP Server。
 */
function validateHttpServer(context: ExtensionValidateContext, server: DiscoveredMcpServer): void {
  /** 当前 Server 已由 transport 判别为 HTTP 的定义。 */
  const definition = server.definition as Extract<McpServerDefinition, { transport: 'http' }>;
  /** field 表示当前定义的一个公开字段，用于拒绝宽类型绕过检查。 */
  for (const field of Object.keys(definition)) {
    if (!HTTP_FIELDS.has(field)) {
      context.reportDiagnostic({
        code: 'MCP_FIELD_UNKNOWN', severity: 'error', message: `Unknown HTTP MCP field "${field}".`,
        location: { path: serverLocation(context, server) }, fieldPath: [field],
      });
    }
  }
  /** 成功解析时的标准 URL，用于协议、凭据和主机安全检查。 */
  let url: URL | undefined;
  try {
    if (typeof definition.url !== 'string')
      throw new TypeError('URL must be a string.');
    url = new URL(definition.url);
  } catch {
    context.reportDiagnostic({
      code: 'MCP_URL_INVALID', severity: 'error', message: `MCP Server "${server.id}" has an invalid URL.`,
      location: { path: serverLocation(context, server) }, fieldPath: ['url'],
    });
  }
  if (url !== undefined) {
    /** development 允许的明确 loopback 主机。 */
    const loopback = ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
    if (url.username !== '' || url.password !== '') {
      context.reportDiagnostic({
        code: 'MCP_URL_CREDENTIALS_FORBIDDEN', severity: 'error', message: 'MCP URLs must not contain credentials.',
        location: { path: serverLocation(context, server) }, fieldPath: ['url'],
      });
    }
    if (context.mode === 'production' && url.protocol !== 'https:') {
      context.reportDiagnostic({
        code: 'MCP_HTTPS_REQUIRED', severity: 'error', message: `MCP Server "${server.id}" must use HTTPS in production.`,
        location: { path: serverLocation(context, server) }, fieldPath: ['url'],
      });
    }
    if (context.mode === 'development' && url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
      context.reportDiagnostic({
        code: 'MCP_HTTP_LOOPBACK_ONLY', severity: 'error',
        message: `MCP Server "${server.id}" may use HTTP only on loopback in development.`,
        location: { path: serverLocation(context, server) }, fieldPath: ['url'],
      });
    }
  }

  if (definition.auth !== undefined) {
    /** auth 候选值必须为无自定义原型的普通对象。 */
    const auth = definition.auth as unknown;
    if (!isPlainObject(auth)) {
      context.reportDiagnostic({
        code: 'MCP_AUTH_INVALID', severity: 'error', message: 'MCP auth must be a plain object.',
        location: { path: serverLocation(context, server) }, fieldPath: ['auth'],
      });
    } else {
      /** field 表示当前认证声明字段，用于拒绝策略之外的 Secret 或命令配置。 */
      for (const field of Object.keys(auth)) {
        if (!AUTH_FIELDS.has(field)) {
          context.reportDiagnostic({
            code: 'MCP_AUTH_FIELD_UNKNOWN', severity: 'error', message: `Unknown MCP auth field "${field}".`,
            location: { path: serverLocation(context, server) }, fieldPath: ['auth', field],
          });
        }
      }
      if (auth.type !== 'none' && auth.type !== 'oauth' && auth.type !== 'bearer') {
        context.reportDiagnostic({
          code: 'MCP_AUTH_TYPE_INVALID', severity: 'error', message: 'MCP auth type must be none, oauth, or bearer.',
          location: { path: serverLocation(context, server) }, fieldPath: ['auth', 'type'],
        });
      }
      if (auth.type === 'none' && (Object.hasOwn(auth, 'env') || Object.hasOwn(auth, 'scopes'))) {
        context.reportDiagnostic({
          code: 'MCP_AUTH_FIELD_INVALID', severity: 'error', message: 'MCP none auth cannot declare env or scopes.',
          location: { path: serverLocation(context, server) }, fieldPath: ['auth'],
        });
      }
      if (auth.type === 'bearer'
        && (typeof auth.env !== 'string' || !ENV_NAME_PATTERN.test(auth.env) || Object.hasOwn(auth, 'scopes'))) {
        context.reportDiagnostic({
          code: 'MCP_BEARER_INVALID', severity: 'error', message: 'MCP bearer auth requires one valid env and no scopes.',
          location: { path: serverLocation(context, server) }, fieldPath: ['auth'],
        });
      }
      if (auth.type === 'oauth') {
        if (Object.hasOwn(auth, 'env')) {
          context.reportDiagnostic({
            code: 'MCP_AUTH_FIELD_INVALID', severity: 'error', message: 'MCP OAuth auth cannot declare env.',
            location: { path: serverLocation(context, server) }, fieldPath: ['auth', 'env'],
          });
        }
        if (auth.scopes !== undefined && (!Array.isArray(auth.scopes)
          || auth.scopes.some(scope => typeof scope !== 'string' || scope.trim().length === 0)
          || new Set(auth.scopes).size !== auth.scopes.length)) {
          context.reportDiagnostic({
            code: 'MCP_OAUTH_SCOPE_INVALID', severity: 'error',
            message: 'MCP OAuth scopes must contain unique non-empty strings.',
            location: { path: serverLocation(context, server) }, fieldPath: ['auth', 'scopes'],
          });
        }
      }
    }
  }
  validateValueSources(context, server, definition.headers, ['headers']);
}

/**
 * 校验本地 stdio Server 的入口边界、普通文件属性和环境映射。
 *
 * @param context Core 提供的工程和诊断出口。
 * @param server 当前本地 MCP Server。
 */
async function validateStdioServer(context: ExtensionValidateContext, server: DiscoveredMcpServer): Promise<void> {
  /** 当前 Server 已由 transport 判别为 stdio 的定义。 */
  const definition = server.definition as Extract<McpServerDefinition, { transport: 'stdio' }>;
  /** field 表示当前定义的一个公开字段，用于拒绝宽类型绕过检查。 */
  for (const field of Object.keys(definition)) {
    if (!STDIO_FIELDS.has(field)) {
      context.reportDiagnostic({
        code: 'MCP_FIELD_UNKNOWN', severity: 'error', message: `Unknown stdio MCP field "${field}".`,
        location: { path: serverLocation(context, server) }, fieldPath: [field],
      });
    }
  }
  /** 默认或显式配置解析出的本地 Server 绝对入口。 */
  const entryValue = definition.entry ?? './server.ts';
  if (typeof entryValue !== 'string' || entryValue.trim().length === 0 || path.isAbsolute(entryValue)) {
    context.reportDiagnostic({
      code: 'MCP_ENTRY_INVALID', severity: 'error', message: `MCP Server "${server.id}" entry must be a relative non-empty path.`,
      location: { path: serverLocation(context, server) }, fieldPath: ['entry'],
    });
  } else {
    /** 用真实 Server 目录解析但不跟随候选入口符号链接。 */
    const entry = path.resolve(server.directory, entryValue);
    /** 用于发现目录逃逸的入口相对路径。 */
    const relative = path.relative(server.directory, entry);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      context.reportDiagnostic({
        code: 'MCP_ENTRY_ESCAPE', severity: 'error', message: `MCP Server "${server.id}" entry must stay inside its directory.`,
        location: { path: serverLocation(context, server) }, fieldPath: ['entry'],
      });
    } else {
      try {
        /** lstat 用于拒绝入口文件本身是符号链接。 */
        const stat = await fs.lstat(entry);
        if (!stat.isFile() || stat.isSymbolicLink())
          throw new TypeError('Entry is not a regular file.');
      } catch {
        context.reportDiagnostic({
          code: 'MCP_ENTRY_MISSING', severity: 'error', message: `MCP Server "${server.id}" entry cannot be used.`,
          location: { path: serverLocation(context, server) }, fieldPath: ['entry'],
        });
      }
    }
  }
  validateValueSources(context, server, definition.env, ['env']);
}

/**
 * 验证全部 MCP Server 的静态 Schema 与安全边界。
 *
 * @param context Core 提供的规范工程和构建模式。
 * @param discovered discover 阶段得到的稳定 Server 列表。
 */
export async function validateMcpServers(
  context: ExtensionValidateContext,
  discovered: Readonly<DiscoveredMcpServers>,
): Promise<void> {
  /** server 表示当前待验证的远程声明或本地实现。 */
  for (const server of discovered.servers) {
    /** transport 在作者使用宽类型时仍可能是未知值。 */
    const transport = (server.definition as { readonly transport?: unknown }).transport;
    if (transport === 'http')
      validateHttpServer(context, server);
    else if (transport === 'stdio')
      await validateStdioServer(context, server);
    else {
      context.reportDiagnostic({
        code: 'MCP_TRANSPORT_UNSUPPORTED', severity: 'error',
        message: `MCP Server "${server.id}" transport is unsupported.`,
        location: { path: serverLocation(context, server) }, fieldPath: ['transport'],
      });
    }
  }
}
