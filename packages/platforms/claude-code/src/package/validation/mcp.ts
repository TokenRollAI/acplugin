/** Claude Code MCP wire contract validator。 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { JsonValue } from '@tokenroll/acplugin/sdk';
import {
  isRecord,
  report,
  type PlatformValidateContext,
} from './shared.js';

/** MCP Server key 使用与 Plugin 身份一致的稳定 lowercase-kebab 规则。 */
const PLUGIN_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Claude Code MCP 配置文件唯一允许的包装字段。 */
const MCP_CONFIG_FIELDS = new Set(['mcpServers']);

/** Claude Code Plugin-local stdio MCP descriptor 字段。 */
const MCP_STDIO_FIELDS = new Set(['type', 'command', 'args', 'env']);

/** Claude Code 远程 HTTP MCP descriptor 字段。 */
const MCP_HTTP_FIELDS = new Set(['type', 'url', 'headers', 'oauth']);

/** 校验字符串映射，不允许 headers/env 退化为任意 JSON。 */
function validateStringMap(
  context: PlatformValidateContext,
  value: JsonValue | undefined,
  code: string,
  label: string,
  fieldPath: readonly (string | number)[],
): void {
  if (value !== undefined && (!isRecord(value)
    || Object.entries(value).some(([key, entry]) => key.trim().length === 0 || typeof entry !== 'string'))) {
    report(context, code, `${label} must map non-empty names to string values.`, fieldPath);
  }
}

/** 校验 Claude Code 最终将加载的 MCP Server 映射。 */
export function validateMcpServers(
  context: PlatformValidateContext,
  value: JsonValue,
  fieldPath: readonly (string | number)[],
): void {
  if (!isRecord(value)) {
    report(context, 'CLAUDE_MCP_SERVERS_INVALID', 'mcpServers must contain a Server object mapping.', fieldPath);
    return;
  }
  for (const [id, candidate] of Object.entries(value)) {
    /** 当前 Server 在最终配置中的字段路径。 */
    const serverPath = [...fieldPath, id];
    if (!PLUGIN_NAME_PATTERN.test(id) || !isRecord(candidate)) {
      report(context, 'CLAUDE_MCP_SERVER_INVALID', 'MCP Server ids must use lowercase kebab-case and map to objects.', serverPath);
      continue;
    }
    /** type 决定 stdio 与 HTTP 的精确字段集合。 */
    const fields = candidate.type === 'stdio'
      ? MCP_STDIO_FIELDS
      : candidate.type === 'http'
        ? MCP_HTTP_FIELDS
        : undefined;
    if (fields === undefined) {
      report(context, 'CLAUDE_MCP_TRANSPORT_INVALID', 'MCP Server type must be stdio or http.', [...serverPath, 'type']);
      continue;
    }
    for (const field of Object.keys(candidate)) {
      if (!fields.has(field))
        report(context, 'CLAUDE_MCP_FIELD_UNKNOWN', `Unknown Claude Code MCP field "${field}".`, [...serverPath, field]);
    }
    if (candidate.type === 'stdio') {
      if (typeof candidate.command !== 'string' || candidate.command.trim().length === 0)
        report(context, 'CLAUDE_MCP_COMMAND_INVALID', 'stdio MCP command must be a non-empty string.', [...serverPath, 'command']);
      if (candidate.args !== undefined
        && (!Array.isArray(candidate.args) || candidate.args.some(argument => typeof argument !== 'string'))) {
        report(context, 'CLAUDE_MCP_ARGS_INVALID', 'stdio MCP args must contain only strings.', [...serverPath, 'args']);
      }
      validateStringMap(context, candidate.env, 'CLAUDE_MCP_ENV_INVALID', 'stdio MCP env', [...serverPath, 'env']);
      continue;
    }
    if (typeof candidate.url !== 'string') {
      report(context, 'CLAUDE_MCP_URL_INVALID', 'HTTP MCP url must be an HTTP(S) URL without credentials.', [...serverPath, 'url']);
    } else {
      try {
        /** 远程地址不得把凭据内联到 URL。 */
        const url = new URL(candidate.url);
        if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username !== '' || url.password !== '')
          throw new TypeError('unsafe');
      } catch {
        report(context, 'CLAUDE_MCP_URL_INVALID', 'HTTP MCP url must be an HTTP(S) URL without credentials.', [...serverPath, 'url']);
      }
    }
    validateStringMap(context, candidate.headers, 'CLAUDE_MCP_HEADERS_INVALID', 'HTTP MCP headers', [...serverPath, 'headers']);
    if (candidate.oauth !== undefined) {
      if (!isRecord(candidate.oauth)) {
        report(context, 'CLAUDE_MCP_OAUTH_INVALID', 'HTTP MCP oauth must be an object.', [...serverPath, 'oauth']);
      } else {
        for (const field of Object.keys(candidate.oauth)) {
          if (field !== 'scopes')
            report(context, 'CLAUDE_MCP_OAUTH_FIELD_UNKNOWN', `Unknown Claude Code MCP OAuth field "${field}".`, [...serverPath, 'oauth', field]);
        }
        if (candidate.oauth.scopes !== undefined
          && (typeof candidate.oauth.scopes !== 'string' || candidate.oauth.scopes.trim().length === 0)) {
          report(context, 'CLAUDE_MCP_OAUTH_INVALID', 'HTTP MCP oauth.scopes must be a non-empty string.', [...serverPath, 'oauth', 'scopes']);
        }
      }
    }
  }
}

/** 读取并校验 Plugin 根内被引用的 Claude Code MCP 配置。 */
export async function validateMcpFile(
  context: PlatformValidateContext,
  pluginRoot: string,
  reference: string,
  fieldPath: readonly (string | number)[],
): Promise<void> {
  try {
    /** MCP 配置引用相对于当前 Plugin 根解析。 */
    const mcpPath = path.join(context.candidate.root, pluginRoot, reference.slice(2));
    /** 被引用文件必须使用 `{ mcpServers }` 包装。 */
    const value: unknown = JSON.parse(await fs.readFile(mcpPath, 'utf8'));
    if (!isRecord(value)) {
      report(context, 'CLAUDE_MCP_CONFIG_INVALID', 'MCP config must contain a JSON object.', fieldPath);
      return;
    }
    for (const field of Object.keys(value)) {
      if (!MCP_CONFIG_FIELDS.has(field))
        report(context, 'CLAUDE_MCP_CONFIG_FIELD_UNKNOWN', `Unknown Claude Code MCP config field "${field}".`, [...fieldPath, field]);
    }
    if (value.mcpServers === undefined)
      report(context, 'CLAUDE_MCP_SERVERS_REQUIRED', 'MCP config must contain mcpServers.', [...fieldPath, 'mcpServers']);
    else
      validateMcpServers(context, value.mcpServers, [...fieldPath, 'mcpServers']);
  } catch {
    report(context, 'CLAUDE_MCP_CONFIG_READ_FAILED', 'MCP config reference must contain valid JSON.', fieldPath);
  }
}
