/** Header 或进程环境值的公开字面量来源。 */
export interface LiteralValueSource {
  /** 明确允许进入构建产物的非敏感字符串。 */
  readonly value: string;
}

/** Header 或进程环境值的运行时环境变量来源。 */
export interface EnvironmentValueSource {
  /** 只进入产物的环境变量名称；构建阶段不会读取对应值。 */
  readonly env: string;
}

/** MCP Header 或环境字段可使用的两种互斥来源。 */
export type ValueSource = LiteralValueSource | EnvironmentValueSource;

/** 不需要认证的远程 MCP 声明。 */
export interface NoMcpAuth {
  /** 明确关闭认证。 */
  readonly type: 'none';
}

/** 由安装平台完成授权流程的 OAuth 声明。 */
export interface OAuthMcpAuth {
  /** 使用平台原生 OAuth 支持。 */
  readonly type: 'oauth';
  /** 请求的非空 OAuth Scope。 */
  readonly scopes?: readonly string[];
}

/** 从宿主环境读取 Token 的 Bearer 认证声明。 */
export interface BearerMcpAuth {
  /** 使用 Bearer Token。 */
  readonly type: 'bearer';
  /** 运行时读取 Token 的环境变量名称。 */
  readonly env: string;
}

/** 规范远程 MCP 支持的认证策略。 */
export type McpAuth = NoMcpAuth | OAuthMcpAuth | BearerMcpAuth;

/** 由 defineMcpServer 注入且不出现在作者输入中的私有品牌。 */
const mcpServerBrand: unique symbol = Symbol('acplugin.mcp-server');

/** 远程 HTTP MCP Server 的平台中立静态描述。 */
export interface HttpMcpServer {
  /** 仅由 defineMcpServer 注入的名义类型品牌。 */
  readonly [mcpServerBrand]: true;
  /** 固定为远程 HTTP 传输。 */
  readonly transport: 'http';
  /** Server 的完整 HTTPS 或开发期 loopback URL。 */
  readonly url: string;
  /** 无认证、OAuth 或 Bearer 环境变量认证。 */
  readonly auth?: McpAuth;
  /** 公开字面量或运行时环境变量 Header。 */
  readonly headers?: Readonly<Record<string, ValueSource>>;
}

/** 由作者提供完整实现的本地 stdio MCP Server 描述。 */
export interface StdioMcpServer {
  /** 仅由 defineMcpServer 注入的名义类型品牌。 */
  readonly [mcpServerBrand]: true;
  /** 固定为本地 stdio 传输。 */
  readonly transport: 'stdio';
  /** 相对于当前 MCP 目录的入口，默认 `./server.ts`。 */
  readonly entry?: string;
  /** 传给 Server 进程的公开字面量或运行时环境变量。 */
  readonly env?: Readonly<Record<string, ValueSource>>;
}

/** 远程 HTTP 与本地 stdio 组成的规范 MCP Server 联合类型。 */
export type McpServerDefinition = HttpMcpServer | StdioMcpServer;

/** 配置作者提供的 MCP 定义，不包含框架私有品牌。 */
export type McpServerInput
  = | Omit<HttpMcpServer, typeof mcpServerBrand>
    | Omit<StdioMcpServer, typeof mcpServerBrand>;

/**
 * 为 MCP Server 定义提供联合类型推断，并注入不可枚举的运行时品牌。
 *
 * @param definition 作者提供的远程声明或本地实现配置。
 * @returns 冻结且只能由当前包识别的 MCP Server 定义。
 */
export function defineMcpServer(definition: McpServerInput): McpServerDefinition {
  /** 使用浅副本隔离作者随后对顶层字段的替换。 */
  const server = { ...definition } as McpServerInput & { [mcpServerBrand]?: true };
  Object.defineProperty(server, mcpServerBrand, { value: true, enumerable: false });
  return Object.freeze(server) as McpServerDefinition;
}

/**
 * 判断未知导出是否由当前包的 defineMcpServer 工厂创建。
 *
 * @param value TypeScript 描述文件加载后的未知默认导出。
 * @returns 私有品牌存在且基础对象形态有效时返回 true。
 */
export function isMcpServerDefinition(value: unknown): value is McpServerDefinition {
  if (value === null || typeof value !== 'object')
    return false;
  /** 读取私有 Symbol 品牌所需的安全索引视图。 */
  const candidate = value as Record<PropertyKey, unknown>;
  return candidate[mcpServerBrand] === true;
}
