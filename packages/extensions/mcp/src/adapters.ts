import {
  bytesArtifact,
  stableJson,
  type ExtensionPlatformAdapter,
  type JsonValue,
  type PlatformAdapterContext,
  type PlatformId,
} from '@tokenroll/acplugin';
import type { BuiltMcpServer, BuiltMcpServers } from './bundler.js';
import {
  ANTIGRAVITY_PLATFORM_ID,
  CLAUDE_CODE_PLATFORM_ID,
  CODEX_PLATFORM_ID,
  CURSOR_PLATFORM_ID,
  MCP_MANIFEST_PATH,
  OPENCODE_PLATFORM_ID,
  PI_PLATFORM_ID,
  PLUGIN_MANIFEST_ID,
} from './constants.js';
import type { ValueSource } from './types.js';

/** 拆分后可分别映射到平台字面量和环境引用字段的值。 */
interface MappedValues {
  /** 可以直接写入目标清单的非敏感字面量。 */
  readonly literal: Readonly<Record<string, string>>;
  /** 只写变量名称、由安装运行时读取真实值的引用。 */
  readonly environment: Readonly<Record<string, string>>;
}

/**
 * 将 ValueSource 映射拆分为字面量和环境变量引用。
 *
 * @param values Header 或进程环境配置。
 * @returns 按名称稳定插入的 literal 与 environment 映射。
 */
function mapValues(values: Readonly<Record<string, ValueSource>> | undefined): MappedValues {
  /** 可以直接写入目标清单的非敏感字面量。 */
  const literal: Record<string, string> = {};
  /** 只写变量名称、由安装运行时读取真实值的引用。 */
  const environment: Record<string, string> = {};
  /** [name, source] 表示当前已验证的 ValueSource 映射。 */
  for (const [name, source] of Object.entries(values ?? {}).sort(([left], [right]) => left.localeCompare(right, 'en'))) {
    if ('value' in source)
      literal[name] = source.value;
    else
      environment[name] = source.env;
  }
  return Object.freeze({ literal: Object.freeze(literal), environment: Object.freeze(environment) });
}

/**
 * 把规范 MCP 定义转换为 Claude Code `.mcp.json` Server 描述。
 *
 * @param server 已验证并可能完成本地构建的 MCP Server。
 * @returns Claude Code 使用的 stdio 或 HTTP 配置。
 */
function claudeDescriptor(server: BuiltMcpServer): Readonly<Record<string, JsonValue>> {
  /** 当前 Server 的可判别联合定义。 */
  const definition = server.definition;
  if (definition.transport === 'stdio') {
    /** 拆分后的进程环境字面量与宿主变量引用。 */
    const values = mapValues(definition.env);
    /** 运行时环境变量使用 Claude Code 支持的 `${NAME}` 插值。 */
    const environment = Object.fromEntries(
      Object.entries(values.environment).map(([name, env]) => [name, `\${${env}}`]),
    );
    return Object.freeze({
      type: 'stdio',
      command: 'node',
      args: Object.freeze([`\${CLAUDE_PLUGIN_ROOT}/mcp/${server.id}/server.mjs`]),
      ...(Object.keys(values.literal).length === 0 && Object.keys(environment).length === 0
        ? {}
        : { env: Object.freeze({ ...values.literal, ...environment }) }),
    });
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
  return Object.freeze({
    type: 'http',
    url: definition.url,
    ...(Object.keys(headers).length === 0 ? {} : { headers: Object.freeze(headers) }),
    ...(definition.auth?.type === 'oauth' && definition.auth.scopes !== undefined
      ? { oauth: Object.freeze({ scopes: definition.auth.scopes.join(' ') }) }
      : {}),
  });
}

/**
 * 把规范 MCP 定义转换为 Codex Plugin MCP Server 描述。
 *
 * @param server 已验证并可能完成本地构建的 MCP Server。
 * @returns Codex 使用的 stdio 或 HTTP 配置。
 */
function codexDescriptor(server: BuiltMcpServer): Readonly<Record<string, JsonValue>> {
  /** 当前 Server 的可判别联合定义。 */
  const definition = server.definition;
  if (definition.transport === 'stdio') {
    /** 拆分后的进程环境字面量与宿主变量引用。 */
    const values = mapValues(definition.env);
    return Object.freeze({
      command: 'node',
      args: Object.freeze([`./mcp/${server.id}/server.mjs`]),
      cwd: '.',
      ...(Object.keys(values.literal).length === 0 ? {} : { env: values.literal }),
      ...(Object.keys(values.environment).length === 0
        ? {}
        : { env_vars: Object.freeze([...new Set(Object.values(values.environment))].sort()) }),
    });
  }
  /** 拆分后的 HTTP Header 字面量与宿主变量引用。 */
  const values = mapValues(definition.headers);
  return Object.freeze({
    url: definition.url,
    ...(definition.auth?.type === 'bearer' ? { bearer_token_env_var: definition.auth.env } : {}),
    ...(definition.auth?.type === 'oauth' && definition.auth.scopes !== undefined
      ? { scopes: Object.freeze([...definition.auth.scopes]) }
      : {}),
    ...(Object.keys(values.literal).length === 0 ? {} : { http_headers: values.literal }),
    ...(Object.keys(values.environment).length === 0 ? {} : { env_http_headers: values.environment }),
  });
}

/**
 * 报告一个 MCP Server 在默认平台上的实际传输和认证能力。
 *
 * @param context 当前 Platform Adapter 上下文。
 * @param server 正在适配的 MCP Server。
 */
function reportCompatibility(context: PlatformAdapterContext, server: BuiltMcpServer): void {
  context.reportCompatibility({
    subject: `mcp:${server.id}`,
    capability: `transport.${server.definition.transport}`,
    level: 'native',
    reason: `${context.platform.id} supports ${server.definition.transport} MCP Servers.`,
  });
  if (server.definition.transport === 'http' && server.definition.auth !== undefined) {
    context.reportCompatibility({
      subject: `mcp:${server.id}`,
      capability: `auth.${server.definition.auth.type}`,
      level: 'native',
      reason: `${context.platform.id} can express the selected MCP authentication reference.`,
    });
  }
}

/**
 * 向当前默认 Plugin Draft 贡献 Server Bundle、许可、MCP 清单和 Manifest 引用。
 *
 * @param context Core 提供的受限 Adapter API。
 * @param built Extension build 阶段产生的平台中立状态。
 * @param platform 当前官方 Adapter 的 Platform ID。
 */
async function applyDefaultAdapter(
  context: PlatformAdapterContext,
  built: Readonly<BuiltMcpServers>,
  platform: typeof CLAUDE_CODE_PLATFORM_ID | typeof CODEX_PLATFORM_ID,
): Promise<void> {
  if (built.servers.length === 0)
    return;
  /** Platform 必须提供约定的 Plugin Manifest Document 才能安全建立引用。 */
  if (context.getDocument(PLUGIN_MANIFEST_ID) === undefined) {
    context.reportDiagnostic({
      code: 'MCP_PLATFORM_DOCUMENT_MISSING', severity: 'error',
      message: `Platform "${platform}" does not expose the required Plugin Manifest document.`,
    });
    return;
  }
  for (const server of built.servers) {
    if (server.definition.transport === 'stdio') {
      if (server.bundle === undefined) {
        context.reportDiagnostic({
          code: 'MCP_BUNDLE_MISSING', severity: 'error', message: `MCP Server "${server.id}" has no local bundle.`,
        });
        continue;
      }
      context.emitArtifact({
        path: `mcp/${server.id}/server.mjs`,
        source: { type: 'file', path: server.bundle.server },
        mode: 0o755,
      });
      if (server.bundle.licenses !== undefined) {
        context.emitArtifact({
          path: `mcp/${server.id}/THIRD_PARTY_LICENSES.txt`,
          source: { type: 'file', path: server.bundle.licenses },
          mode: 0o644,
        });
      }
    }
    reportCompatibility(context, server);
  }
  /** 平台协议决定顶层是否使用 mcpServers 包裹。 */
  const descriptors = Object.fromEntries(built.servers.map(server => [
    server.id,
    platform === CLAUDE_CODE_PLATFORM_ID ? claudeDescriptor(server) : codexDescriptor(server),
  ]));
  /** Claude Code 使用 wrapped 形式，Codex Plugin 使用 direct server map。 */
  const manifest = platform === CLAUDE_CODE_PLATFORM_ID ? { mcpServers: descriptors } : descriptors;
  context.emitArtifact(bytesArtifact(MCP_MANIFEST_PATH, stableJson(manifest)));
  context.patchDocument({
    document: PLUGIN_MANIFEST_ID,
    path: ['mcpServers'],
    value: `./${MCP_MANIFEST_PATH}`,
  });
}

/**
 * 把 HTTP MCP Header 映射为运行时环境插值字符串。
 *
 * @param server 已验证的远程 MCP Server。
 * @param environmentReference 根据 Platform 生成环境变量引用的函数。
 * @returns 合并公开字面量、环境引用和可选 Bearer Header 的稳定对象。
 */
function remoteHeaders(
  server: BuiltMcpServer,
  environmentReference: (name: string) => string,
): Readonly<Record<string, string>> {
  if (server.definition.transport !== 'http')
    return Object.freeze({});
  /** 拆分后的 Header 字面量和环境变量名称。 */
  const values = mapValues(server.definition.headers);
  /** 最终平台配置只包含公开值或环境变量引用。 */
  const headers: Record<string, string> = {
    ...values.literal,
    ...Object.fromEntries(Object.entries(values.environment).map(([name, env]) => [name, environmentReference(env)])),
  };
  if (server.definition.auth?.type === 'bearer')
    headers.Authorization = `Bearer ${environmentReference(server.definition.auth.env)}`;
  return Object.freeze(headers);
}

/**
 * 报告 remote-only Platform 对一个 MCP Server 的精确能力结论。
 *
 * @param context 当前 Platform Adapter 上下文。
 * @param server 正在适配的 MCP Server。
 */
function reportRemoteOnlyCompatibility(context: PlatformAdapterContext, server: BuiltMcpServer): void {
  if (server.definition.transport === 'stdio') {
    context.reportCompatibility({
      subject: `mcp:${server.id}`,
      capability: 'transport.stdio',
      level: 'unsupported',
      reason: `${context.platform.id} has no verified portable Plugin-root contract for bundled stdio MCP Servers.`,
    });
    return;
  }
  context.reportCompatibility({
    subject: `mcp:${server.id}`,
    capability: 'transport.http',
    level: 'native',
    reason: `${context.platform.id} supports remote HTTP MCP Servers.`,
  });
  if (server.definition.auth?.type === 'oauth' && (server.definition.auth.scopes?.length ?? 0) > 0) {
    context.reportCompatibility({
      subject: `mcp:${server.id}`,
      capability: 'auth.oauth.scopes',
      level: 'degraded',
      transformation: 'The platform performs OAuth discovery without requested scope hints.',
      reason: `${context.platform.id} Plugin MCP configuration has no verified OAuth scopes field.`,
    });
  } else if (server.definition.auth !== undefined) {
    context.reportCompatibility({
      subject: `mcp:${server.id}`,
      capability: `auth.${server.definition.auth.type}`,
      level: 'native',
      reason: `${context.platform.id} can express the selected authentication reference.`,
    });
  }
}

/**
 * 创建 Cursor remote MCP Server 描述。
 *
 * @param server 已验证的远程 Server。
 * @returns Cursor mcp.json 中的单个 Server 配置。
 */
function cursorDescriptor(server: BuiltMcpServer): Readonly<Record<string, JsonValue>> {
  if (server.definition.transport !== 'http')
    throw new TypeError('Cursor MCP Adapter accepts only remote HTTP Servers.');
  /** Cursor 在 JSON 配置中使用 `${env:NAME}` 延迟读取宿主环境。 */
  const headers = remoteHeaders(server, name => `\${env:${name}}`);
  return Object.freeze({
    url: server.definition.url,
    ...(Object.keys(headers).length === 0 ? {} : { headers }),
  });
}

/**
 * 创建 Antigravity remote MCP Server 描述。
 *
 * @param server 已验证的远程 Server。
 * @returns mcp_config.json 中的单个 Server 配置。
 */
function antigravityDescriptor(server: BuiltMcpServer): Readonly<Record<string, JsonValue>> {
  if (server.definition.transport !== 'http')
    throw new TypeError('Antigravity MCP Adapter accepts only remote HTTP Servers.');
  /** Antigravity 的 MCP 配置沿用 `${NAME}` 运行时环境插值。 */
  const headers = remoteHeaders(server, name => `\${${name}}`);
  return Object.freeze({
    type: 'http',
    url: server.definition.url,
    ...(Object.keys(headers).length === 0 ? {} : { headers }),
  });
}

/**
 * 应用 Cursor remote-only MCP Adapter。
 *
 * @param context Core 提供的受限 Adapter API。
 * @param built MCP Extension 的平台中立 Built State。
 */
async function applyCursorAdapter(
  context: PlatformAdapterContext,
  built: Readonly<BuiltMcpServers>,
): Promise<void> {
  for (const server of built.servers)
    reportRemoteOnlyCompatibility(context, server);
  /** Cursor 首期只生成可移植 remote HTTP 配置。 */
  const remote = built.servers.filter(server => server.definition.transport === 'http');
  if (remote.length === 0)
    return;
  if (context.getDocument(PLUGIN_MANIFEST_ID) === undefined) {
    context.reportDiagnostic({
      code: 'MCP_PLATFORM_DOCUMENT_MISSING', severity: 'error',
      message: 'Cursor Platform does not expose the required Plugin Manifest document.',
    });
    return;
  }
  /** Cursor 使用与生态 mcp.json 一致的 wrapped server map。 */
  const mcpServers = Object.fromEntries(remote.map(server => [server.id, cursorDescriptor(server)]));
  context.emitArtifact(bytesArtifact('mcp.json', stableJson({ mcpServers })));
  context.patchDocument({ document: PLUGIN_MANIFEST_ID, path: ['mcpServers'], value: './mcp.json' });
}

/**
 * 应用 Antigravity remote-only MCP Adapter。
 *
 * @param context Core 提供的受限 Adapter API。
 * @param built MCP Extension 的平台中立 Built State。
 */
async function applyAntigravityAdapter(
  context: PlatformAdapterContext,
  built: Readonly<BuiltMcpServers>,
): Promise<void> {
  for (const server of built.servers)
    reportRemoteOnlyCompatibility(context, server);
  /** Antigravity 首期只生成可移植 remote HTTP 配置。 */
  const remote = built.servers.filter(server => server.definition.transport === 'http');
  if (remote.length === 0)
    return;
  /** 官方 Plugin 根结构使用 mcp_config.json，不需要 Manifest 引用。 */
  const mcpServers = Object.fromEntries(remote.map(server => [server.id, antigravityDescriptor(server)]));
  context.emitArtifact(bytesArtifact('mcp_config.json', stableJson({ mcpServers })));
}

/**
 * 创建 OpenCode remote/local MCP Server 描述。
 *
 * @param server 已验证并可能带本地 Bundle 的 Server。
 * @returns opencode.json.mcp 中的单个配置。
 */
function openCodeDescriptor(server: BuiltMcpServer): Readonly<Record<string, JsonValue>> {
  /** 当前 Server 的可判别联合定义。 */
  const definition = server.definition;
  if (definition.transport === 'stdio') {
    /** 拆分后的进程环境字面量与运行时引用。 */
    const values = mapValues(definition.env);
    /** OpenCode 配置使用 `{env:NAME}` 延迟读取宿主环境。 */
    const environment = {
      ...values.literal,
      ...Object.fromEntries(Object.entries(values.environment).map(([name, env]) => [name, `{env:${env}}`])),
    };
    return Object.freeze({
      type: 'local',
      command: Object.freeze(['node', `./.opencode/mcp/${server.id}/server.mjs`]),
      ...(Object.keys(environment).length === 0 ? {} : { environment: Object.freeze(environment) }),
      enabled: true,
    });
  }
  /** 远程 Header 只含公开值和 OpenCode 环境引用。 */
  const headers = remoteHeaders(server, name => `{env:${name}}`);
  return Object.freeze({
    type: 'remote',
    url: definition.url,
    ...(Object.keys(headers).length === 0 ? {} : { headers }),
    ...(definition.auth?.type === 'oauth' && definition.auth.scopes !== undefined
      ? { oauth: Object.freeze({ scopes: Object.freeze([...definition.auth.scopes]) }) }
      : {}),
    enabled: true,
  });
}

/**
 * 应用 OpenCode remote/local MCP Adapter。
 *
 * @param context Core 提供的受限 Adapter API。
 * @param built MCP Extension 的平台中立 Built State。
 */
async function applyOpenCodeAdapter(
  context: PlatformAdapterContext,
  built: Readonly<BuiltMcpServers>,
): Promise<void> {
  if (built.servers.length === 0)
    return;
  if (context.getDocument('workspace-config') === undefined) {
    context.reportDiagnostic({
      code: 'MCP_PLATFORM_DOCUMENT_MISSING', severity: 'error',
      message: 'OpenCode Platform does not expose the required workspace config document.',
    });
    return;
  }
  for (const server of built.servers) {
    if (server.definition.transport === 'stdio') {
      if (server.bundle === undefined) {
        context.reportDiagnostic({
          code: 'MCP_BUNDLE_MISSING', severity: 'error', message: `MCP Server "${server.id}" has no local bundle.`,
        });
        continue;
      }
      context.emitArtifact({
        path: `.opencode/mcp/${server.id}/server.mjs`,
        source: { type: 'file', path: server.bundle.server },
        mode: 0o755,
      });
      if (server.bundle.licenses !== undefined) {
        context.emitArtifact({
          path: `.opencode/mcp/${server.id}/THIRD_PARTY_LICENSES.txt`,
          source: { type: 'file', path: server.bundle.licenses },
          mode: 0o644,
        });
      }
    }
    reportCompatibility(context, server);
  }
  /** OpenCode Platform Document 拥有最终 opencode.json 序列化。 */
  const descriptors = Object.fromEntries(built.servers.map(server => [server.id, openCodeDescriptor(server)]));
  context.patchDocument({ document: 'workspace-config', path: ['mcp'], value: descriptors });
}

/**
 * 应用明确不支持 MCP 的 Pi Adapter。
 *
 * @param context Core 提供的兼容性报告出口。
 * @param built MCP Extension 的平台中立 Built State。
 */
async function applyPiAdapter(
  context: PlatformAdapterContext,
  built: Readonly<BuiltMcpServers>,
): Promise<void> {
  /** server 表示当前资源，用于逐项报告且绝不生成伪配置。 */
  for (const server of built.servers) {
    context.reportCompatibility({
      subject: `mcp:${server.id}`,
      capability: `transport.${server.definition.transport}`,
      level: 'unsupported',
      reason: 'Pi has no first-class MCP package configuration and acplugin does not add an implicit client Extension.',
    });
  }
}

/**
 * 创建 MCP Extension 内置的六个平台 Adapter。
 *
 * @returns 只通过 Core 受限 API 写入平台 Draft 的固定 Adapter 列表。
 */
export function createMcpAdapters(): readonly ExtensionPlatformAdapter<BuiltMcpServers>[] {
  /** Claude Code 官方 Adapter。 */
  const claudeCode: ExtensionPlatformAdapter<BuiltMcpServers> = Object.freeze({
    extensionApiVersion: '1',
    platform: CLAUDE_CODE_PLATFORM_ID as PlatformId,
    platformApiVersion: '1',
    /** 把平台中立状态落为 Claude Code wrapped MCP 配置。 */
    apply: (context: PlatformAdapterContext, built: Readonly<BuiltMcpServers>) => applyDefaultAdapter(
      context,
      built,
      CLAUDE_CODE_PLATFORM_ID,
    ),
  });
  /** Codex 官方 Adapter。 */
  const codex: ExtensionPlatformAdapter<BuiltMcpServers> = Object.freeze({
    extensionApiVersion: '1',
    platform: CODEX_PLATFORM_ID as PlatformId,
    platformApiVersion: '1',
    /** 把平台中立状态落为 Codex direct MCP 配置。 */
    apply: (context: PlatformAdapterContext, built: Readonly<BuiltMcpServers>) => applyDefaultAdapter(
      context,
      built,
      CODEX_PLATFORM_ID,
    ),
  });
  /** Cursor 官方 Adapter。 */
  const cursor: ExtensionPlatformAdapter<BuiltMcpServers> = Object.freeze({
    extensionApiVersion: '1',
    platform: CURSOR_PLATFORM_ID as PlatformId,
    platformApiVersion: '1',
    /** 只生成 remote HTTP mcp.json；stdio 精确报告 unsupported。 */
    apply: applyCursorAdapter,
  });
  /** Antigravity 官方 Adapter。 */
  const antigravity: ExtensionPlatformAdapter<BuiltMcpServers> = Object.freeze({
    extensionApiVersion: '1',
    platform: ANTIGRAVITY_PLATFORM_ID as PlatformId,
    platformApiVersion: '1',
    /** 只生成 remote HTTP mcp_config.json；stdio 精确报告 unsupported。 */
    apply: applyAntigravityAdapter,
  });
  /** OpenCode 官方 Adapter。 */
  const openCode: ExtensionPlatformAdapter<BuiltMcpServers> = Object.freeze({
    extensionApiVersion: '1',
    platform: OPENCODE_PLATFORM_ID as PlatformId,
    platformApiVersion: '1',
    /** 生成 workspace mcp 配置和可移植 local Server Bundle。 */
    apply: applyOpenCodeAdapter,
  });
  /** Pi 明确 unsupported Adapter。 */
  const pi: ExtensionPlatformAdapter<BuiltMcpServers> = Object.freeze({
    extensionApiVersion: '1',
    platform: PI_PLATFORM_ID as PlatformId,
    platformApiVersion: '1',
    /** 只报告无一等 MCP 能力，不生成 Artifact。 */
    apply: applyPiAdapter,
  });
  return Object.freeze([claudeCode, codex, cursor, antigravity, openCode, pi]);
}
