/** Legacy MCP 的安全远程映射与脱敏 sidecar writer helper。 */
import type { MCPServer } from '../legacy/types.js';

/**
 * 识别仅包含 `${ENV_NAME}` 的安全环境变量引用。
 *
 * @param value 旧配置中的字符串值。
 * @returns 环境变量名称；包含字面量或无效语法时返回 undefined。
 */
function environmentReference(value: string): string | undefined {
  /** 完整匹配环境变量插值的捕获结果。 */
  const match = value.match(/^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/);
  return match?.[1];
}

/**
 * 尝试把无凭据、HTTPS 且只引用环境变量的旧远程 MCP 转为类型化定义源码。
 *
 * @param server Legacy Scanner 读取的 MCP Server。
 * @returns 可安全自动迁移的 `mcp.ts` 源码，否则返回 undefined 并转入未映射区。
 */
export function remoteMcpSource(server: MCPServer): string | undefined {
  if (!server.url || !['http', 'streamable-http', undefined].includes(server.type))
    return undefined;
  /** 完成语法与敏感 URL 组件检查的远程端点。 */
  let endpoint: URL;
  try {
    endpoint = new URL(server.url);
  } catch {
    return undefined;
  }
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash)
    return undefined;
  /** 仅保留环境变量引用的非认证 Header。 */
  const headers: Record<string, unknown> = {};
  /** 从 Authorization Header 提取的可选 Bearer 环境变量策略。 */
  let auth: Record<string, string> | undefined;
  for (const [name, value] of Object.entries(server.headers ?? {})) {
    /** Authorization Header 是否是可安全迁移的 Bearer 环境变量引用。 */
    const bearer = name.toLowerCase() === 'authorization' && value.match(/^Bearer \$\{([A-Za-z_][A-Za-z0-9_]*)\}$/);
    if (bearer) {
      auth = { type: 'bearer', env: bearer[1]! };
      continue;
    }
    /** 普通 Header 值中唯一允许保留的环境变量名。 */
    const env = environmentReference(value);
    if (!env)
      return undefined;
    headers[name] = { env };
  }
  /** 按稳定格式组装的类型化 MCP 描述源码行。 */
  const descriptor = [
    `import type { McpServer } from '@tokenroll/acplugin-extension-mcp';`,
    '',
    'export default {',
    `  transport: 'http',`,
    `  url: ${JSON.stringify(endpoint.href)},`,
    ...(auth ? [`  auth: ${JSON.stringify(auth)},`] : []),
    ...(Object.keys(headers).length ? [`  headers: ${JSON.stringify(headers, null, 2).replaceAll('\n', '\n  ')},`] : []),
    '} satisfies McpServer;',
    '',
  ];
  return descriptor.join('\n');
}

/**
 * 创建可供人工恢复的旧 MCP 摘要，同时移除参数、环境值、Header 值和 URL 凭据。
 *
 * @param server 无法自动迁移的旧 MCP Server。
 * @returns 不包含已知敏感值的结构化摘要。
 */
export function redactedMcpServer(server: MCPServer): Record<string, unknown> {
  /** 清除凭据、查询和片段后的可选 URL。 */
  let url = server.url;
  if (url) {
    try {
      /** 用于移除用户信息、查询和片段的 URL 副本。 */
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
