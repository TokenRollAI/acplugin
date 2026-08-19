import type { ExtensionBuildContext, GeneratedAssetRef, PortableNodeCompileOptions } from '@tokenroll/acplugin/sdk';
import type { DiscoveredMcpServers } from './discovery.js';

/** 当前固定 smoke 请求使用的 MCP 协议版本。 */
const MCP_PROTOCOL_VERSION = '2025-11-25';

/** JSON-RPC/MCP 结构只接受普通对象。 */
function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** JSON-RPC request/response ID 的稳定去重键。 */
function rpcIdKey(value: unknown): string | undefined {
  if (typeof value === 'string') return `string:${value}`;
  if (typeof value === 'number' && Number.isFinite(value)) return `number:${value}`;
  if (value === null) return 'null';
  return undefined;
}

/** 验证一条 stdout 消息满足 JSON-RPC 2.0 request/notification/response envelope。 */
function isJsonRpcMessage(value: unknown): value is Record<string, unknown> {
  if (!isObject(value) || value.jsonrpc !== '2.0') return false;
  if (Object.hasOwn(value, 'method')) {
    if (typeof value.method !== 'string' || value.method.length === 0) return false;
    if (Object.hasOwn(value, 'id') && rpcIdKey(value.id) === undefined) return false;
    return !Object.hasOwn(value, 'params') || isObject(value.params) || Array.isArray(value.params);
  }
  if (!Object.hasOwn(value, 'id') || rpcIdKey(value.id) === undefined) return false;
  /** result 字段存在性用于约束 response 的二选一分支。 */
  const hasResult = Object.hasOwn(value, 'result');
  /** error 字段存在性与 result 必须恰好互斥。 */
  const hasError = Object.hasOwn(value, 'error');
  if (hasResult === hasError) return false;
  if (!hasError) return true;
  /** error payload 必须满足 JSON-RPC 稳定错误形状。 */
  const error = value.error;
  return isObject(error) && Number.isInteger(error.code) && typeof error.message === 'string';
}

/** 验证 initialize 与 tools/list 的精确 MCP 结果形状。 */
function validateMcpSmokeOutput(stdout: Uint8Array): boolean {
  try {
    /** stdio MCP 每行承载一条独立 JSON-RPC 消息。 */
    const lines = new TextDecoder().decode(stdout).split(/\r?\n/u).filter(line => line.length > 0);
    /** request/response ID 在整个 smoke 输出中不能重复。 */
    const ids = new Set<string>();
    /** 两个请求对应的唯一响应。 */
    let initialize: Record<string, unknown> | undefined;
    /** tools/list 请求对应的唯一响应。 */
    let tools: Record<string, unknown> | undefined;
    for (const line of lines) {
      /** 单行 JSON 解析结果在读取字段前经过完整 envelope 校验。 */
      const message: unknown = JSON.parse(line);
      if (!isJsonRpcMessage(message)) return false;
      if (Object.hasOwn(message, 'id')) {
        /** 规范化 ID 键防止字符串和数值碰撞或重复响应。 */
        const key = rpcIdKey(message.id)!;
        if (ids.has(key)) return false;
        ids.add(key);
      }
      /** 带 method 的消息是 Server request/notification，不是 smoke 响应。 */
      if (Object.hasOwn(message, 'method')) continue;
      if (message.id === 1) initialize = message;
      if (message.id === 2) tools = message;
    }
    if (initialize === undefined || tools === undefined || Object.hasOwn(initialize, 'error') || Object.hasOwn(tools, 'error')) return false;
    /** initialize result 必须声明精确协议版本与 Server 身份。 */
    const initializeResult = initialize.result;
    if (!isObject(initializeResult)
      || initializeResult.protocolVersion !== MCP_PROTOCOL_VERSION
      || !isObject(initializeResult.capabilities)
      || !isObject(initializeResult.serverInfo)
      || typeof initializeResult.serverInfo.name !== 'string'
      || initializeResult.serverInfo.name.length === 0
      || typeof initializeResult.serverInfo.version !== 'string'
      || initializeResult.serverInfo.version.length === 0)
      return false;
    /** tools/list result 必须提供可逐项验证的 tools 数组。 */
    const toolsResult = tools.result;
    if (!isObject(toolsResult) || !Array.isArray(toolsResult.tools)) return false;
    return toolsResult.tools.every(tool => isObject(tool)
      && typeof tool.name === 'string'
      && tool.name.length > 0
      && isObject(tool.inputSchema));
  } catch {
    return false;
  }
}

/** MCP Build State 中一个可跨 Platform 复用的 stdio Bundle。 */
export interface BuiltMcpServer {
  readonly id: string;
  readonly definition: DiscoveredMcpServers['servers'][number]['definition'];
  readonly handler?: GeneratedAssetRef;
  readonly licenses?: GeneratedAssetRef;
}

/** MCP Extension 的不可变 Built State。 */
export interface BuiltMcpServers { readonly servers: readonly BuiltMcpServer[] }

/** 通过 Core portable-node 一次编译所有本地 MCP 入口。 */
export async function buildMcpServers(context: ExtensionBuildContext, validated: Readonly<DiscoveredMcpServers>, compile?: PortableNodeCompileOptions): Promise<BuiltMcpServers> {
  /** 仅本地 stdio Server 需要生成 Bundle。 */
  const local = validated.servers.filter(server => server.definition.transport === 'stdio');
  /** 每个本地入口对应一个可执行编译条目。 */
  const entries = Object.fromEntries(local.map(server => [server.id, Object.freeze({ type: 'source' as const, source: server.entrySource!, mode: 0o755 as const })]));
  /** 延迟初始化 Compile Result，保证 HTTP-only 不创建 Job。 */
  let result: Awaited<ReturnType<ExtensionBuildContext['compiler']['compile']>> | undefined;
  if (local.length > 0) {
    try {
      /** Core portable-node 统一编译全部 stdio 入口。 */
      result = await context.compiler.compile({ id: 'mcp', profile: 'portable-node', entries, sourceScopes: Object.freeze([validated.root]), ...(compile === undefined ? {} : { options: compile }) });
    } catch (error) {
      /** 底层解析失败只映射为稳定 unresolved-import 诊断。 */
      const message = error instanceof Error ? error.message : '';
      if (/dynamic import|unresolved import|could not resolve/iu.test(message)) {
        context.diagnostics.report({ code: 'BUILD_UNRESOLVED_IMPORT', severity: 'error', message: 'MCP stdio bundle contains an unresolved import.' });
      }
      throw error;
    }
  }
  /** 按 Server ID 把 Core 输出映射为 Extension Built State。 */
  const servers = validated.servers.map((server) => {
    if (server.definition.transport === 'http') return Object.freeze({ id: server.id, definition: server.definition });
    /** 当前 stdio entry 的全部 Core 输出。 */
    const outputs = result!.outputs.filter(output => output.outputId === server.id);
    /** 固定唯一可执行 main.mjs。 */
    const main = outputs.find(output => output.type === 'chunk' && output.isEntry && output.fileName === 'main.mjs');
    /** 可选相邻第三方许可证材料。 */
    const licenses = outputs.find(output => output.type === 'licenses' && output.fileName === 'THIRD_PARTY_LICENSES.txt');
    if (main === undefined) throw new Error(`Compiler returned no MCP entry for "${server.id}".`);
    return Object.freeze({ id: server.id, definition: server.definition, handler: main.asset, ...(licenses === undefined ? {} : { licenses: licenses.asset }) });
  });
  /** 对每个 stdio Bundle 运行固定 JSON-RPC initialize/tools/list smoke。 */
  for (const server of servers) {
    if (server.definition.transport !== 'stdio')
      continue;
    /** 当前 Bundle 的 Core 生成入口引用。 */
    const handler = (server as BuiltMcpServer).handler;
    if (handler === undefined)
      continue;
    /** Smoke 进程只接收作者明确给出的公开 literal 环境。 */
    const environment = Object.fromEntries(Object.entries(server.definition.env ?? {})
      .filter((entry): entry is [string, { readonly value: string }] => 'value' in entry[1])
      .map(([name, source]) => [name, source.value]));
    /** 固定的 MCP initialize、initialized 和 tools/list 请求序列。 */
    const input = [
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'acplugin-smoke', version: '1' } } }),
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
      '',
    ].join('\n');
    /** Core Execution Host 提供超时、输出上限和最小环境。 */
    const result = await context.execution.runNode({ entry: handler, stdin: input, timeoutMs: 5000, maxOutputBytes: 256 * 1024, environment });
    /** 正常退出和精确 JSON-RPC/MCP response shape 同时成立才通过。 */
    const valid = result.status === 'exited' && result.exitCode === 0 && validateMcpSmokeOutput(result.stdout);
    if (!valid) {
      /** 原始 stdout/stderr 不进入诊断，避免泄漏作者运行时内容。 */
      context.diagnostics.report({ code: 'MCP_STDIO_SMOKE_FAILED', severity: 'error', message: `MCP Server "${server.id}" failed the initialize/tools-list protocol smoke.` });
    }
  }
  return Object.freeze({ servers: Object.freeze(servers) });
}
