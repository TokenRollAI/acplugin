import type { ContributionContext, JsonValue, PlatformContributor } from '@tokenroll/acplugin/sdk';
import type { BuiltMcpServer, BuiltMcpServers } from '../build.js';
import {
  addJsonAsset,
  addLocalRuntime,
  collector,
  finishContribution,
  mapValues,
  reportAuth,
  reportTransport,
  serverSubjects,
} from './common.js';

/** @returns Claude Code 原生 MCP descriptor。 */
function descriptor(server: BuiltMcpServer): JsonValue {
  /** definition 是经过 Extension 验证的纯数据快照。 */
  const definition = server.definition;
  if (definition.transport === 'stdio') {
    /** Claude Code env 字段允许 Plugin 运行时环境引用。 */
    const values = mapValues(definition.env);
    /** env 合并公开字面量与不会在构建阶段求值的引用。 */
    const environment = {
      ...values.literal,
      ...Object.fromEntries(Object.entries(values.environment).map(([key, name]) => [key, `\${${name}}`])),
    };
    return {
      type: 'stdio',
      command: 'node',
      args: [`\${CLAUDE_PLUGIN_ROOT}/mcp/${server.id}/server.mjs`],
      ...(Object.keys(environment).length === 0 ? {} : { env: environment }),
    };
  }
  /** HTTP Header 使用 Claude Code 的环境变量插值。 */
  const values = mapValues(definition.headers);
  /** headers 保留作者字段名和运行时引用。 */
  const headers: Record<string, string> = {
    ...values.literal,
    ...Object.fromEntries(Object.entries(values.environment).map(([key, name]) => [key, `\${${name}}`])),
  };
  if (definition.auth?.type === 'bearer')
    headers.Authorization = `Bearer \${${definition.auth.env}}`;
  return {
    type: 'http',
    url: definition.url,
    ...(Object.keys(headers).length === 0 ? {} : { headers }),
    ...(definition.auth?.type === 'oauth'
      ? { oauth: definition.auth.scopes === undefined ? {} : { scopes: definition.auth.scopes.join(' ') } }
      : {}),
  };
}

/** Claude Code Contributor 交付 Plugin-local stdio 与远程 HTTP MCP。 */
export const claudeCodeContributor: PlatformContributor<BuiltMcpServers> = Object.freeze({
  platform: 'claude-code',
  platformApiVersion: '1',
  /** 生成 Claude Code MCP 配置和本地 Bundle 引用。 */
  async contribute(context: ContributionContext, built: Readonly<BuiltMcpServers>) {
    /** output 汇聚当前 owner 的 Assets 和 compatibility。 */
    const output = collector();
    for (const server of built.servers) {
      reportTransport(output, server, 'native', 'Claude Code supports this MCP transport.');
      reportAuth(output, server, 'native', 'Claude Code preserves this MCP authentication policy.');
      if (server.definition.transport === 'stdio')
        addLocalRuntime(output, server, 'mcp');
    }
    if (built.servers.length === 0)
      return finishContribution(output);
    /** descriptors 按已稳定排序的 Built State 创建。 */
    const descriptors = Object.fromEntries(built.servers.map(server => [server.id, descriptor(server)]));
    await addJsonAsset(context, output, '.mcp.json', { mcpServers: descriptors }, serverSubjects(built.servers));
    return finishContribution(output, [{ document: 'plugin-manifest', path: ['mcpServers'], value: './.mcp.json' }]);
  },
});
