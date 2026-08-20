/** Codex MCP wire contract validator。 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { JsonValue } from '@tokenroll/acplugin/sdk';
import {
  isRecord,
  report,
  type PlatformValidateContext,
} from './shared.js';

/** Codex 本地 stdio MCP descriptor 允许的字段。 */
const MCP_STDIO_FIELDS = new Set(['command', 'args', 'cwd', 'env', 'env_vars']);

/** Codex 远程 HTTP MCP descriptor 允许的字段。 */
const MCP_HTTP_FIELDS = new Set([
  'url', 'bearer_token_env_var', 'scopes', 'http_headers', 'env_http_headers',
]);

/** Codex 运行时环境变量名称的保守规则。 */
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** MCP Server key 使用 framework 稳定的 lowercase-kebab 规则。 */
const SKILL_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** 校验 Codex MCP 的字符串键值映射。 */
function validateMcpStringMap(
  context: PlatformValidateContext,
  value: JsonValue | undefined,
  code: string,
  label: string,
  fieldPath: readonly (string | number)[],
  environmentValues = false,
): void {
  if (value !== undefined && (!isRecord(value) || Object.entries(value).some(([key, entry]) =>
    key.trim().length === 0 || typeof entry !== 'string' || (environmentValues && !ENV_NAME_PATTERN.test(entry))))) {
    report(context, code, `${label} must map non-empty names to valid string values.`, fieldPath);
  }
}

/** 校验 Codex 最终 `.mcp.json` 中的完整 Server 映射。 */
function validateMcpServers(context: PlatformValidateContext, value: JsonValue, fieldPath: readonly (string | number)[]): void {
  if (!isRecord(value)) {
    report(context, 'CODEX_MCP_SERVERS_INVALID', 'Codex MCP config must contain a Server object mapping.', fieldPath);
    return;
  }
  for (const [id, candidate] of Object.entries(value)) {
    /** 当前 Server 在最终配置中的字段路径。 */
    const serverPath = [...fieldPath, id];
    if (!SKILL_ID_PATTERN.test(id) || !isRecord(candidate)) {
      report(context, 'CODEX_MCP_SERVER_INVALID', 'MCP Server ids must use lowercase kebab-case and map to objects.', serverPath);
      continue;
    }
    /** url/command 必须恰好选择一种传输。 */
    const remote = Object.hasOwn(candidate, 'url');
    /** command 表示 Plugin-local stdio 传输。 */
    const local = Object.hasOwn(candidate, 'command');
    if (remote === local) {
      report(context, 'CODEX_MCP_TRANSPORT_INVALID', 'MCP Server must declare exactly one of url or command.', serverPath);
      continue;
    }
    /** 当前传输唯一允许的字段集合。 */
    const fields = remote ? MCP_HTTP_FIELDS : MCP_STDIO_FIELDS;
    for (const field of Object.keys(candidate)) {
      if (!fields.has(field))
        report(context, 'CODEX_MCP_FIELD_UNKNOWN', `Unknown Codex MCP field "${field}".`, [...serverPath, field]);
    }
    if (local) {
      if (typeof candidate.command !== 'string' || candidate.command.trim().length === 0)
        report(context, 'CODEX_MCP_COMMAND_INVALID', 'stdio MCP command must be a non-empty string.', [...serverPath, 'command']);
      if (candidate.args !== undefined
        && (!Array.isArray(candidate.args) || candidate.args.some(argument => typeof argument !== 'string'))) {
        report(context, 'CODEX_MCP_ARGS_INVALID', 'stdio MCP args must contain only strings.', [...serverPath, 'args']);
      }
      if (candidate.cwd !== undefined && candidate.cwd !== '.')
        report(context, 'CODEX_MCP_CWD_INVALID', 'Plugin stdio MCP cwd must be the Plugin root ".".', [...serverPath, 'cwd']);
      validateMcpStringMap(context, candidate.env, 'CODEX_MCP_ENV_INVALID', 'stdio MCP env', [...serverPath, 'env']);
      if (candidate.env_vars !== undefined
        && (!Array.isArray(candidate.env_vars) || candidate.env_vars.some(variable => typeof variable !== 'string' || !ENV_NAME_PATTERN.test(variable))
          || new Set(candidate.env_vars).size !== candidate.env_vars.length)) {
        report(context, 'CODEX_MCP_ENV_VARS_INVALID', 'stdio MCP env_vars must contain unique environment names.', [...serverPath, 'env_vars']);
      }
      continue;
    }
    if (typeof candidate.url !== 'string') {
      report(context, 'CODEX_MCP_URL_INVALID', 'HTTP MCP url must be an HTTP(S) URL without credentials.', [...serverPath, 'url']);
    } else {
      try {
        /** Codex remote MCP 不接受 URL 内联凭据。 */
        const url = new URL(candidate.url);
        if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username !== '' || url.password !== '')
          throw new TypeError('unsafe');
      } catch {
        report(context, 'CODEX_MCP_URL_INVALID', 'HTTP MCP url must be an HTTP(S) URL without credentials.', [...serverPath, 'url']);
      }
    }
    if (candidate.bearer_token_env_var !== undefined
      && (typeof candidate.bearer_token_env_var !== 'string' || !ENV_NAME_PATTERN.test(candidate.bearer_token_env_var))) {
      report(context, 'CODEX_MCP_BEARER_INVALID', 'bearer_token_env_var must be an environment name.', [...serverPath, 'bearer_token_env_var']);
    }
    if (candidate.scopes !== undefined
      && (!Array.isArray(candidate.scopes) || candidate.scopes.length === 0
        || candidate.scopes.some(scope => typeof scope !== 'string' || scope.trim().length === 0)
        || new Set(candidate.scopes).size !== candidate.scopes.length)) {
      report(context, 'CODEX_MCP_SCOPES_INVALID', 'MCP scopes must contain unique non-empty strings.', [...serverPath, 'scopes']);
    }
    validateMcpStringMap(context, candidate.http_headers, 'CODEX_MCP_HEADERS_INVALID', 'HTTP MCP headers', [...serverPath, 'http_headers']);
    validateMcpStringMap(context, candidate.env_http_headers, 'CODEX_MCP_ENV_HEADERS_INVALID', 'HTTP MCP env headers', [...serverPath, 'env_http_headers'], true);
  }
}

/** 读取并校验 Codex Plugin 根内被引用的 `.mcp.json`。 */
export async function validateMcpFile(
  context: PlatformValidateContext,
  pluginRoot: string,
  reference: string,
  fieldPath: readonly (string | number)[],
): Promise<void> {
  try {
    /** MCP 配置引用相对于当前 Plugin 根解析。 */
    const mcpPath = path.join(context.candidate.root, pluginRoot, reference.slice(2));
    /** Codex `.mcp.json` 顶层直接是 Server 映射。 */
    const value: unknown = JSON.parse(await fs.readFile(mcpPath, 'utf8'));
    validateMcpServers(context, value as JsonValue, fieldPath);
  } catch {
    report(context, 'CODEX_MCP_CONFIG_READ_FAILED', 'mcpServers reference must contain valid JSON.', fieldPath);
  }
}
