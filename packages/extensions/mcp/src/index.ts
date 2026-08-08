import { defineExtension, type AcpluginExtension } from '@tokenroll/acplugin';
import { createMcpAdapters } from './adapters.js';
import type { BuiltMcpServers } from './bundler.js';
import { EXTENSION_NAME, MCP_ID_PATTERN } from './constants.js';
import {
  discoverMcpServers,
  type DiscoveredMcpServers,
  validateMcpServers,
} from './discovery.js';

export { EXTENSION_NAME } from './constants.js';
export { defineMcpServer } from './types.js';
export type {
  BearerMcpAuth,
  EnvironmentValueSource,
  HttpMcpServer,
  LiteralValueSource,
  McpAuth,
  McpServerDefinition,
  McpServerInput,
  NoMcpAuth,
  OAuthMcpAuth,
  StdioMcpServer,
  ValueSource,
} from './types.js';

/** 创建 MCP Extension 时可声明的横向构建选项。 */
export interface McpExtensionOptions {
  /** 只构建这些 `src/mcp/<id>`；省略时构建全部 Server。 */
  readonly include?: readonly string[];
}

/** MCP Extension 工厂当前接受的公开配置字段。 */
const MCP_OPTION_FIELDS = new Set(['include']);

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
function normalizeInclude(include: McpExtensionOptions['include']): ReadonlySet<string> | undefined {
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
  return result;
}

/**
 * 创建端到端拥有 MCP 作者格式、Bundle 和官方 Adapter 的品牌化 Extension。
 *
 * @param options 可选的 MCP Server ID 白名单。
 * @returns 参与 Core 固定生命周期的 MCP Extension。
 */
export function mcp(
  options: McpExtensionOptions = {},
): AcpluginExtension<DiscoveredMcpServers | undefined, BuiltMcpServers> {
  validateOptions(options);
  /** 每个 Extension 实例独占且不可被作者随后修改的 include 集合。 */
  const include = normalizeInclude(options.include);
  return defineExtension<DiscoveredMcpServers | undefined, BuiltMcpServers>({
    name: EXTENSION_NAME,
    apiVersion: '1',
    /** 扫描 Extension 独占的 `src/mcp` 作者格式。 */
    discover: context => discoverMcpServers(context, include),
    /** 在 Bundle 前验证远程安全策略与本地入口边界。 */
    validate: (context, discovered) => discovered === undefined
      ? undefined
      : validateMcpServers(context, discovered),
    /** HTTP 声明无需加载 Bundler；只有实际 stdio 资源才动态引入 Rolldown。 */
    build: async (context, discovered) => {
      if (discovered === undefined)
        return Object.freeze({ servers: Object.freeze([]) });
      if (discovered.servers.every(server => server.definition.transport === 'http')) {
        return Object.freeze({
          servers: Object.freeze(discovered.servers.map(server => Object.freeze({
            id: server.id,
            definition: server.definition,
          }))),
        });
      }
      /**
       * 本地实现出现时才加载独立发布的重型构建入口。
       *
       * URL 形式让只内联 HTTP 验证路径的消费者无需把 Rolldown 纳入自身构建图；正式
       * Extension tarball 始终同时携带 bundler.mjs。
       */
      const bundlerUrl = new URL('./bundler.mjs', import.meta.url);
      /** 独立入口导出的本地 Bundle 与协议 smoke 实现。 */
      const { buildMcpServers } = await import(bundlerUrl.href) as typeof import('./bundler.js');
      return buildMcpServers(context, discovered);
    },
    adapters: createMcpAdapters(),
  });
}

export default mcp;
