import type { MCPConfig, Platform, ConvertedFile } from '../types.js';
import { toToml } from '../utils/toml.js';

/**
 * Replace ${CLAUDE_PLUGIN_ROOT} with relative path.
 * All target platforms use relative paths from plugin root.
 */
function transformPluginRootPaths(value: string): string {
  return value
    .replace(/"\$\{CLAUDE_PLUGIN_ROOT\}\/([^"]+)"/g, './$1')
    .replace(/\$\{CLAUDE_PLUGIN_ROOT\}\//g, './')
    .replace(/\$\{CLAUDE_PLUGIN_ROOT\}/g, '.');
}

function transformArgs(args: string[]): string[] {
  return args.map(a => transformPluginRootPaths(a));
}

function transformEnv(env: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    result[k] = transformPluginRootPaths(v);
  }
  return result;
}

export function convertMCP(mcp: MCPConfig, platform: Platform): ConvertedFile {
  switch (platform) {
    case 'codex':
      return convertToCodex(mcp);
    case 'opencode':
      return convertToOpenCode(mcp);
    case 'cursor':
      return convertToCursor(mcp);
    case 'antigravity':
      return convertToAntigravity(mcp);
    case 'pi':
      // Pi does not support MCP by design; the Pi writer emits a warning
      // instead of calling this converter.
      throw new Error('Pi does not support MCP');
  }
}

function convertToCodex(mcp: MCPConfig): ConvertedFile {
  // Generate TOML [mcp_servers.X] sections
  const mcpServers: Record<string, Record<string, unknown>> = {};

  for (const server of mcp.servers) {
    const config: Record<string, unknown> = {};

    if (server.type === 'http' && server.url) {
      config.url = server.url;
      if (server.headers) {
        config.http_headers = server.headers;
      }
    } else {
      if (server.command) config.command = server.command;
      if (server.args) config.args = transformArgs(server.args);
    }

    if (server.env && Object.keys(server.env).length > 0) {
      config.env = transformEnv(server.env);
    }

    config.enabled = true;
    mcpServers[server.name] = config;
  }

  const content = toToml({ mcp_servers: mcpServers });
  return {
    path: '.codex/config.toml',
    content: `# MCP servers converted from Claude Code .mcp.json\n\n${content}`,
    type: 'mcp',
  };
}

function convertToOpenCode(mcp: MCPConfig): ConvertedFile {
  const mcpConfig: Record<string, unknown> = {};

  for (const server of mcp.servers) {
    if (server.type === 'http' && server.url) {
      mcpConfig[server.name] = {
        type: 'remote',
        url: server.url,
        enabled: true,
        ...(server.headers ? { headers: server.headers } : {}),
      };
    } else {
      // OpenCode expects a single string array for command+args, and uses
      // `environment` (not `env`) for env vars. See opencode.ai/docs/mcp-servers.
      const commandArray = [
        ...(server.command ? [server.command] : []),
        ...transformArgs(server.args || []),
      ];
      mcpConfig[server.name] = {
        type: 'local',
        command: commandArray,
        enabled: true,
        ...(server.env && Object.keys(server.env).length > 0 ? { environment: transformEnv(server.env) } : {}),
      };
    }
  }

  const content = JSON.stringify({ mcp: mcpConfig }, null, 2);
  return {
    path: 'opencode.json',
    content,
    type: 'mcp',
  };
}

function convertToCursor(mcp: MCPConfig): ConvertedFile {
  // Cursor format is almost identical to Claude's .mcp.json
  const mcpServers: Record<string, unknown> = {};

  for (const server of mcp.servers) {
    const config: Record<string, unknown> = {};

    if (server.type === 'http' && server.url) {
      config.url = server.url;
      if (server.headers) config.headers = server.headers;
    } else {
      if (server.command) config.command = server.command;
      if (server.args) config.args = transformArgs(server.args);
      if (server.env && Object.keys(server.env).length > 0) {
        config.env = transformEnv(server.env);
      }
    }

    mcpServers[server.name] = config;
  }

  const content = JSON.stringify({ mcpServers }, null, 2);
  return {
    path: '.cursor/mcp.json',
    content,
    type: 'mcp',
  };
}

function convertToAntigravity(mcp: MCPConfig): ConvertedFile {
  // Antigravity uses a dedicated mcp_config.json (not the legacy Gemini CLI
  // settings.json). Remote servers use `serverUrl` (not `url`/`httpUrl`).
  // See github.com/github/github-mcp-server install-antigravity guide.
  const mcpServers: Record<string, unknown> = {};

  for (const server of mcp.servers) {
    const config: Record<string, unknown> = {};

    if (server.type === 'http' && server.url) {
      config.serverUrl = server.url;
      if (server.headers) config.headers = server.headers;
    } else {
      if (server.command) config.command = server.command;
      if (server.args) config.args = transformArgs(server.args);
      if (server.env && Object.keys(server.env).length > 0) {
        config.env = transformEnv(server.env);
      }
    }

    mcpServers[server.name] = config;
  }

  const content = JSON.stringify({ mcpServers }, null, 2);
  return {
    path: '.agents/mcp_config.json',
    content,
    type: 'mcp',
  };
}
