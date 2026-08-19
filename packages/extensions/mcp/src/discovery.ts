import type {
  ExtensionDiscoverContext,
  ExtensionValidateContext,
  JsonValue,
  SourceDirectoryRef,
  SourceFileRef,
} from '@tokenroll/acplugin/sdk';
import { MCP_ID_PATTERN, ENV_NAME_PATTERN } from './constants.js';
import { compareCodeUnits } from './sorting.js';
import type { McpServer } from './types.js';

/** MCP descriptor 顶层字段由 transport 判别后验证。 */
const FIELDS = new Set(['transport', 'url', 'auth', 'headers', 'entry', 'env']);
/** HTTP 与 stdio 顶层字段集合。 */
const HTTP_FIELDS = new Set(['transport', 'url', 'auth', 'headers']);
/** stdio 只接受本地入口与环境引用。 */
const STDIO_FIELDS = new Set(['transport', 'entry', 'env']);
/** 三种认证分支的精确字段集合。 */
const NONE_AUTH_FIELDS = new Set(['type']);
/** bearer 分支只允许一个环境变量引用。 */
const BEARER_AUTH_FIELDS = new Set(['type', 'env']);
/** oauth 分支只允许静态 scope 声明。 */
const OAUTH_AUTH_FIELDS = new Set(['type', 'scopes']);

/** MCP stdio 入口沿用 Core 的 project-relative POSIX 路径语法。 */
export function isSafeMcpEntryPath(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\\') || value.includes('\0') || value.startsWith('/'))
    return false;
  /** POSIX segment 必须全部显式且不能包含 dot traversal。 */
  const segments = value.split('/');
  return segments.every(segment => segment.length > 0 && segment !== '.' && segment !== '..');
}

/** MCP Extension 发现的单个 owner-bound Server。 */
export interface DiscoveredMcpServer {
  readonly id: string;
  readonly directory: SourceDirectoryRef;
  readonly source: SourceFileRef;
  /** stdio Server 的实际业务入口；HTTP Server 不包含此字段。 */
  readonly entrySource?: SourceFileRef;
  readonly definition: McpServer;
}

/** MCP Extension 的稳定发现 State。 */
export interface DiscoveredMcpServers {
  readonly root: SourceDirectoryRef;
  readonly servers: readonly DiscoveredMcpServer[];
}

/** 仅接受普通 JSON 对象，避免 descriptor 把行为带入 State。 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

/** 把 descriptor 复制成无函数、无 accessor 的 JSON 数据。 */
function jsonSnapshot(value: unknown, path: string, ancestors = new Set<object>()): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value))
      throw new TypeError(`${path} must be finite.`);
    return value;
  }
  if (typeof value !== 'object' || ancestors.has(value)) throw new TypeError(`${path} must be JSON data.`);
  ancestors.add(value);
  try {
    /** 所有自有字段先读取 descriptor，绝不触发 getter。 */
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Array.isArray(value)) {
      if (Object.getOwnPropertySymbols(value).length > 0)
        throw new TypeError(`${path} must not contain symbol fields.`);
      /** 稀疏数组不能形成稳定的 JSON snapshot。 */
      for (let i = 0; i < value.length; i += 1) if (!Object.hasOwn(value, i)) throw new TypeError(`${path} must not be sparse.`);
      /** 数组只允许 index 与 length，不允许隐藏扩展字段。 */
      if (Object.keys(descriptors).some(key => key !== 'length'
        && (!/^(?:0|[1-9][0-9]*)$/u.test(key) || Number(key) >= value.length))) throw new TypeError(`${path} has unknown fields.`);
      /** 逐索引读取 data descriptor，绝不通过 Array.prototype.map 触发 getter。 */
      const result: JsonValue[] = [];
      for (let index = 0; index < value.length; index += 1) {
        /** 稠密索引必须仍是显式 data property。 */
        const descriptor = descriptors[String(index)]!;
        if (!('value' in descriptor))
          throw new TypeError(`${path}[${index}] must be data.`);
        result.push(jsonSnapshot(descriptor.value, `${path}[${index}]`, ancestors));
      }
      return Object.freeze(result);
    }
    /** descriptor 必须是无 Symbol 的普通对象。 */
    if (!isPlainObject(value) || Object.getOwnPropertySymbols(value).length > 0) throw new TypeError(`${path} must be plain.`);
    /** snapshot 输出对象与作者对象完全隔离。 */
    const result: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>;
    for (const key of Object.keys(descriptors).sort()) {
      /** 当前字段的 data descriptor。 */
      const descriptor = descriptors[key]!;
      if (!('value' in descriptor)) throw new TypeError(`${path}.${key} must be data.`);
      /** 递归复制字段值并保持稳定路径。 */
      result[key] = jsonSnapshot(descriptor.value, `${path}.${key}`, ancestors);
    }
    return Object.freeze(result);
  } finally { ancestors.delete(value); }
}

/** Descriptor 快照只允许 MCP 规范的普通字段。 */
function normalizeDefinition(value: unknown): McpServer {
  /** 先建立无行为 JSON snapshot，再验证 MCP Schema。 */
  const snapshot = jsonSnapshot(value, 'MCP descriptor');
  if (!isPlainObject(snapshot) || typeof snapshot.transport !== 'string') throw new TypeError('MCP descriptor is invalid.');
  if (Object.keys(snapshot).some(key => !FIELDS.has(key))) throw new TypeError('MCP descriptor contains unknown fields.');
  return snapshot as unknown as McpServer;
}

/** 发现并加载 src/mcp/<id>/mcp.ts。 */
export async function discoverMcpServers(context: ExtensionDiscoverContext, include?: ReadonlySet<string>): Promise<DiscoveredMcpServers | undefined> {
  /** Extension root 缺失表示本轮没有 MCP 作者资源。 */
  const root = context.roots.mcp;
  if (root === undefined) return undefined;
  /** Core Source Service 枚举并审计作者目录。 */
  const entries = await context.sources.list(root);
  /** 发现成功的 MCP Server 累计列表。 */
  const servers: DiscoveredMcpServer[] = [];
  /** include 校验使用的实际目录 ID 集合。 */
  const found = new Set<string>();
  for (const entry of entries) {
    if (entry.type !== 'directory' || !MCP_ID_PATTERN.test(entry.name)) {
      context.diagnostics.report({ code: 'MCP_ENTRY_INVALID', severity: 'error', message: 'MCP entries must be lowercase kebab-case directories.', location: { path: entry.path } });
      continue;
    }
    if (include !== undefined && !include.has(entry.name)) continue;
    found.add(entry.name);
    try {
      /** mcp.ts 是每个 Server 的唯一 descriptor 入口。 */
      const source = await context.sources.file(entry.directory, 'mcp.ts');
      /** Module Host 负责安全加载 ESM default export。 */
      const raw = await context.modules.loadDefault({ id: `mcp-${entry.name}`, entry: source });
      /** descriptor 进入纯数据边界。 */
      const definition = normalizeDefinition(raw);
      /** stdio 业务入口的受权 SourceRef。 */
      let entrySource: SourceFileRef | undefined;
      if (definition.transport === 'stdio' && isSafeMcpEntryPath(definition.entry ?? 'server.ts')) {
        try {
          entrySource = await context.sources.file(entry.directory, definition.entry ?? 'server.ts');
        } catch {
          /** validate 阶段报告稳定缺失入口。 */
        }
      }
      servers.push(Object.freeze({ id: entry.name, directory: entry.directory, source, definition, ...(entrySource === undefined ? {} : { entrySource }) }));
    } catch (error) {
      /** 只读取底层错误的稳定类别，不把原始路径带入诊断。 */
      const message = error instanceof Error ? error.message : '';
      context.diagnostics.report({
        code: /unknown fields/iu.test(message) ? 'MCP_FIELD_UNKNOWN' : 'MCP_DESCRIPTOR_LOAD_FAILED',
        severity: 'error',
        message: /unknown fields/iu.test(message)
          ? `MCP Server "${entry.name}" descriptor contains unknown fields.`
          : `MCP Server "${entry.name}" descriptor could not be loaded.`,
        location: { path: `${entry.path}/mcp.ts` },
      });
    }
  }
  if (include !== undefined) for (const id of include) if (!found.has(id)) context.diagnostics.report({ code: 'MCP_INCLUDE_MISSING', severity: 'error', message: `Included MCP Server "${id}" does not exist under src/mcp.`, location: { path: `${root.path}/${id}` } });
  return servers.length === 0 ? undefined : Object.freeze({ root, servers: Object.freeze(servers.sort((left, right) => compareCodeUnits(left.id, right.id))) });
}

/** 校验 ValueSource 映射且绝不读取 env 引用值。 */
function validateValues(context: ExtensionValidateContext, server: DiscoveredMcpServer, values: unknown, field: string): void {
  if (values === undefined) return;
  if (!isPlainObject(values)) {
    context.diagnostics.report({ code: 'MCP_VALUE_MAP_INVALID', severity: 'error', message: 'MCP value mappings must be plain objects.', location: { path: server.source.path }, fieldPath: [field] });
    return;
  }
  for (const [name, source] of Object.entries(values)) {
    if (!isPlainObject(source) || Object.keys(source).length !== 1 || (!Object.hasOwn(source, 'value') && !Object.hasOwn(source, 'env')) || (Object.hasOwn(source, 'value') && typeof source.value !== 'string') || (Object.hasOwn(source, 'env') && (typeof source.env !== 'string' || !ENV_NAME_PATTERN.test(source.env))))
      context.diagnostics.report({ code: 'MCP_VALUE_SOURCE_INVALID', severity: 'error', message: `MCP value "${name}" must contain one valid value or env reference.`, location: { path: server.source.path }, fieldPath: [field, name] });
  }
}

/** 验证判别联合对象没有跨 transport 或跨 auth 分支字段。 */
function validateExactFields(
  context: ExtensionValidateContext,
  server: DiscoveredMcpServer,
  value: unknown,
  allowed: ReadonlySet<string>,
  field: string,
): value is Record<string, unknown> {
  if (!isPlainObject(value)) {
    context.diagnostics.report({ code: 'MCP_FIELD_INVALID', severity: 'error', message: `MCP ${field} must be a plain object.`, location: { path: server.source.path }, fieldPath: [field] });
    return false;
  }
  for (const key of Object.keys(value)) {
    if (!allowed.has(key))
      context.diagnostics.report({ code: 'MCP_FIELD_UNKNOWN', severity: 'error', message: `MCP ${field} contains an invalid field for its selected variant.`, location: { path: server.source.path }, fieldPath: [field, key] });
  }
  return true;
}

/** 验证全部 HTTP/stdio MCP 安全约束。 */
export async function validateMcpServers(context: ExtensionValidateContext, discovered: Readonly<DiscoveredMcpServers>): Promise<{ readonly state: Readonly<DiscoveredMcpServers>; readonly subjects: readonly { readonly subject: string; readonly capabilities: readonly string[] }[] }> {
  for (const server of discovered.servers) {
    /** 已快照的联合定义转为只读字段映射。 */
    const definition = server.definition as unknown as Record<string, unknown>;
    if (definition.transport === 'http') {
      if (typeof definition.url !== 'string') context.diagnostics.report({ code: 'MCP_URL_INVALID', severity: 'error', message: 'MCP HTTP url must be a string.', location: { path: server.source.path } });
      else {
        try {
          /** URL 解析只使用 descriptor 中的公开字符串。 */
          const url = new URL(definition.url);
          if (url.username || url.password) throw new Error('credentials');
          if (context.mode === 'production' && url.protocol !== 'https:') throw new Error('https');
          if (context.mode === 'development'
            && url.protocol !== 'https:'
            && (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)))
            throw new Error('scheme');
        } catch (error) {
          /** URL 错误归一化为稳定诊断码。 */
          const reason = error instanceof Error ? error.message : '';
          context.diagnostics.report({ code: reason === 'https' ? 'MCP_HTTPS_REQUIRED' : 'MCP_URL_INVALID', severity: 'error', message: 'MCP HTTP url must be HTTPS in production and loopback HTTP in development.', location: { path: server.source.path } });
        }
      }
      if (definition.auth !== undefined) {
        /** 认证对象只检查规范字段，不读取 Secret。 */
        const auth = definition.auth;
        if (isPlainObject(auth)) {
          if (auth.type === 'none') {
            validateExactFields(context, server, auth, NONE_AUTH_FIELDS, 'auth');
          } else if (auth.type === 'bearer') {
            validateExactFields(context, server, auth, BEARER_AUTH_FIELDS, 'auth');
            if (typeof auth.env !== 'string' || !ENV_NAME_PATTERN.test(auth.env)) context.diagnostics.report({ code: 'MCP_BEARER_INVALID', severity: 'error', message: 'MCP bearer auth requires a valid env name.', location: { path: server.source.path }, fieldPath: ['auth', 'env'] });
          } else if (auth.type === 'oauth') {
            validateExactFields(context, server, auth, OAUTH_AUTH_FIELDS, 'auth');
            if (auth.scopes !== undefined && (!Array.isArray(auth.scopes) || auth.scopes.length === 0 || auth.scopes.some(scope => typeof scope !== 'string' || scope.length === 0) || new Set(auth.scopes).size !== auth.scopes.length)) context.diagnostics.report({ code: 'MCP_OAUTH_INVALID', severity: 'error', message: 'MCP OAuth scopes must be unique non-empty strings.', location: { path: server.source.path }, fieldPath: ['auth', 'scopes'] });
          } else {
            validateExactFields(context, server, auth, NONE_AUTH_FIELDS, 'auth');
            context.diagnostics.report({ code: 'MCP_AUTH_INVALID', severity: 'error', message: 'MCP auth type is unsupported.', location: { path: server.source.path }, fieldPath: ['auth', 'type'] });
          }
        } else validateExactFields(context, server, auth, NONE_AUTH_FIELDS, 'auth');
      }
      validateValues(context, server, definition.headers, 'headers');
      /** HTTP 不接受 stdio 专属字段，即使 descriptor 通过了 TS 类型断言。 */
      validateExactFields(context, server, definition, HTTP_FIELDS, 'server');
    } else if (definition.transport === 'stdio') {
      /** stdio 入口默认固定为当前 Server 目录下的 server.ts。 */
      const entry = definition.entry ?? 'server.ts';
      if (!isSafeMcpEntryPath(entry)) context.diagnostics.report({ code: typeof entry === 'string' && (entry.startsWith('/') || entry.split('/').includes('..')) ? 'MCP_ENTRY_ESCAPE' : 'MCP_ENTRY_INVALID', severity: 'error', message: 'MCP stdio entry must be a safe relative POSIX path without dot, parent, backslash, or NUL segments.', location: { path: server.source.path }, fieldPath: ['entry'] });
      if (isSafeMcpEntryPath(entry) && server.entrySource === undefined) context.diagnostics.report({ code: 'MCP_ENTRY_MISSING', severity: 'error', message: 'MCP stdio entry file does not exist.', location: { path: server.source.path }, fieldPath: ['entry'] });
      validateValues(context, server, definition.env, 'env');
      /** stdio 不接受 HTTP 专属字段。 */
      validateExactFields(context, server, definition, STDIO_FIELDS, 'server');
    } else context.diagnostics.report({ code: 'MCP_TRANSPORT_UNSUPPORTED', severity: 'error', message: `MCP Server "${server.id}" transport is unsupported.`, location: { path: server.source.path } });
  }
  return Object.freeze({ state: discovered, subjects: Object.freeze(discovered.servers.map(server => Object.freeze({ subject: `mcp:${server.id}`, capabilities: Object.freeze([`transport.${server.definition.transport}`]) }))) });
}
