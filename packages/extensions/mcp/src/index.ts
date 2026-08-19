import {
  defineExtension,
  type AcpluginExtension,
  type JsonObject,
  type PortableNodeCompileOptions,
} from '@tokenroll/acplugin/sdk';
import { buildMcpServers, type BuiltMcpServers } from './build.js';
import { createMcpContributors } from './contributors/index.js';
import { MCP_ID_PATTERN } from './constants.js';
import {
  discoverMcpServers,
  type DiscoveredMcpServers,
  validateMcpServers,
} from './discovery.js';

export { EXTENSION_NAME } from './constants.js';
export type {
  BearerMcpAuth,
  EnvironmentValueSource,
  HttpMcpServer,
  LiteralValueSource,
  McpAuth,
  McpServer,
  NoMcpAuth,
  OAuthMcpAuth,
  StdioMcpServer,
  ValueSource,
} from './types.js';

/** 创建 MCP Extension 时可声明的横向构建选项。 */
export interface McpExtensionOptions {
  /** 只构建这些 `src/mcp/<id>`；省略时构建全部 Server。 */
  readonly include?: readonly string[];
  /** 复用 Core portable-node 的公共纯 JSON 编译参数。 */
  readonly compile?: PortableNodeCompileOptions;
}

/** 进入 Core defineExtension 的 JSON-safe MCP options。 */
type McpJsonOptions = JsonObject;

/** MCP Extension 工厂当前接受的公开配置字段。 */
const MCP_OPTION_FIELDS = new Set(['include', 'compile']);

/**
 * 拒绝宽类型变量传入的未知 Extension 工厂字段。
 *
 * @param options 配置作者提供的 MCP Extension 选项。
 */
function validateOptions(options: McpExtensionOptions): void {
  if (options === null || typeof options !== 'object' || Array.isArray(options))
    throw new TypeError('MCP options must be a plain object.');
  for (const field of Object.keys(options)) {
    if (!MCP_OPTION_FIELDS.has(field))
      throw new TypeError(`Unknown MCP option "${field}".`);
  }
}

/**
 * 校验并冻结可选 MCP Server ID 白名单。
 *
 * @param include 配置作者提供的可选 ID 数组。
 * @returns 省略时返回 undefined，否则返回去重后的只读集合。
 */
function normalizeInclude(include: McpExtensionOptions['include']): readonly string[] | undefined {
  if (include === undefined)
    return undefined;
  if (!Array.isArray(include))
    throw new TypeError('MCP include must be an array of lowercase kebab-case IDs.');
  /** 去重后提供给 discover 阶段的 MCP Server ID。 */
  const result = new Set<string>();
  /** id 表示当前显式选择的 MCP Server ID。 */
  for (const id of include) {
    if (typeof id !== 'string' || !MCP_ID_PATTERN.test(id))
      throw new TypeError('MCP include must contain only lowercase kebab-case IDs.');
    if (result.has(id))
      throw new TypeError(`MCP include contains duplicate ID "${id}".`);
    result.add(id);
  }
  return Object.freeze([...result].sort());
}

/**
 * 创建端到端拥有 MCP 作者格式、Bundle 和官方 Contributor 的品牌化 Extension。
 *
 * @param options 可选的 MCP Server ID 白名单。
 * @returns 参与 Core 固定生命周期的 MCP Extension。
 */
export function mcp(
  options: McpExtensionOptions = {},
): AcpluginExtension<JsonObject, DiscoveredMcpServers, DiscoveredMcpServers, BuiltMcpServers> {
  validateOptions(options);
  /** factory 边界复制 include，compile 由 Core defineExtension 深度复制。 */
  const include = normalizeInclude(options.include);
  /** 规范化后交给 Core 的 Extension options。 */
  const normalized: McpJsonOptions = {
    ...(include === undefined ? {} : { include }),
    ...(options.compile === undefined ? {} : { compile: options.compile as PortableNodeCompileOptions & JsonObject }),
  };
  return defineExtension<JsonObject, DiscoveredMcpServers, DiscoveredMcpServers, BuiltMcpServers>({
    id: 'mcp',
    apiVersion: '1',
    /** Core 复制并冻结的作者配置。 */
    options: normalized,
    /** MCP Extension 独占的作者资源根。 */
    resourceRoots: ['mcp'],
    /** 每个 BuildSession 从 setup integrations 派生不可变平台快照。 */
    createSession({ options: sessionOptions }) {
      /** 当前 Session 选中的 Server ID 集合。 */
      const normalized = sessionOptions as McpExtensionOptions;
      /** include 白名单只在当前 Session 内使用。 */
      const selected = normalized.include === undefined
        ? undefined
        : new Set(normalized.include);
      /** 当前 Session 共享的 portable-node 编译参数。 */
      const compile = normalized.compile;
      return {
        /** 扫描 Extension 独占的 `src/mcp` 作者格式。 */
        discover: context => discoverMcpServers(context, selected),
        /** 在 Bundle 前验证远程安全策略与本地入口边界。 */
        validate: (context, discovered) => validateMcpServers(context, discovered),
        /** HTTP-only 状态不会调用 Build Service；本地 stdio 统一委托给 Core。 */
        build: async (context, validated) => ({ state: await buildMcpServers(context, validated, compile) }),
        contributors: createMcpContributors(),
      };
    },
  });
}

export default mcp;
