import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { JsonValue, ValidatePackageContext } from '@tokenroll/acplugin/sdk';
import { WORKSPACE_CONFIG_PATH } from './config-document.js';

/** OpenCode validator 只消费 SDK 的最终 Package candidate Context。 */
type PlatformValidateContext = ValidatePackageContext;

/** OpenCode workspace 配置由 Platform/Extension 允许生成的根字段。 */
const CONFIG_FIELDS = new Set(['$schema', 'mcp']);

/** OpenCode local MCP descriptor 允许的完整字段。 */
const LOCAL_MCP_FIELDS = new Set(['type', 'command', 'environment', 'enabled']);

/** OpenCode remote MCP descriptor 允许的完整字段。 */
const REMOTE_MCP_FIELDS = new Set(['type', 'url', 'headers', 'oauth', 'enabled']);

/** OpenCode MCP Server key 使用稳定 lowercase-kebab 规则。 */
const MCP_SERVER_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

/** JSON 对象的运行时只读索引类型。 */
type JsonRecord = Record<string, JsonValue>;

/**
 * 判断未知值是否为非数组 JSON 对象。
 *
 * @param value 从候选配置解析的未知值。
 * @returns 可以按字段读取时返回 true。
 */
function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * 向 Core 提交 OpenCode 候选校验错误。
 *
 * @param context Platform validatePackage 生命周期上下文。
 * @param code 稳定诊断码。
 * @param message 不包含宿主绝对路径的错误信息。
 */
function report(context: PlatformValidateContext, code: string, message: string): void {
  context.diagnostics.report({ code, severity: 'error', message });
}

/** @returns 安全 workspace-relative POSIX 引用对应的 Asset key。 */
function workspaceAssetPath(value: string): string | undefined {
  if (!value.startsWith('./') || value.includes('\\') || value.includes('\0'))
    return undefined;
  /** relative 必须是非空且不含空、dot 或 parent segment 的路径。 */
  const relative = value.slice(2);
  /** 分段校验避免任一 segment 逃逸 workspace。 */
  const segments = relative.split('/');
  if (relative.length === 0 || segments.some(segment => segment === '' || segment === '.' || segment === '..'))
    return undefined;
  return relative;
}

/** 校验 Platform 将要运行或连接的 OpenCode MCP wire data。 */
async function validateMcp(
  context: PlatformValidateContext,
  assets: ReadonlySet<string>,
  value: JsonRecord,
): Promise<void> {
  for (const [id, candidate] of Object.entries(value)) {
    if (!MCP_SERVER_ID_PATTERN.test(id) || !isRecord(candidate)) {
      report(context, 'OPENCODE_MCP_SERVER_INVALID', `OpenCode MCP Server "${id}" must use lowercase kebab-case and map to an object.`);
      continue;
    }
    /** type 决定当前 descriptor 的 exact field set。 */
    const fields = candidate.type === 'local'
      ? LOCAL_MCP_FIELDS
      : candidate.type === 'remote'
        ? REMOTE_MCP_FIELDS
        : undefined;
    if (fields !== undefined) {
      for (const field of Object.keys(candidate)) {
        if (!fields.has(field))
          report(context, 'OPENCODE_MCP_FIELD_UNKNOWN', `Unknown OpenCode MCP field "${field}" on Server "${id}".`);
      }
    }
    if (candidate.enabled !== undefined && typeof candidate.enabled !== 'boolean')
      report(context, 'OPENCODE_MCP_ENABLED_INVALID', `OpenCode MCP Server "${id}" enabled must be boolean.`);
    if (candidate.type === 'local') {
      /** local command 固定为 node 与当前 Server ID 的唯一 canonical bundle path。 */
      const command = candidate.command;
      if (!Array.isArray(command) || command.length !== 2 || command.some(argument => typeof argument !== 'string')) {
        report(context, 'OPENCODE_MCP_LOCAL_COMMAND_INVALID', `OpenCode local MCP Server "${id}" requires exactly two string command arguments.`);
        continue;
      }
      /** ID、目标路径和可执行 mode 共同封闭最终候选协议。 */
      const expected = `.opencode/mcp/${id}/server.mjs`;
      /** command[1] 已由完整字符串数组检查收窄。 */
      const entry = workspaceAssetPath(command[1] as string);
      /** 只有当前 ID 的固定路径才可作为本地 Server。 */
      let executable = false;
      if (entry === expected && assets.has(expected)) {
        try {
          /** candidate 是 Core 临时物化且已闭包校验的只读树。 */
          const stat = await fs.lstat(path.join(context.candidate.root, expected));
          executable = stat.isFile() && !stat.isSymbolicLink() && (stat.mode & 0o777) === 0o755;
        } catch {
          executable = false;
        }
      }
      if (command[0] !== 'node' || entry !== expected || !executable)
        report(context, 'OPENCODE_MCP_LOCAL_ENTRY_INVALID', `OpenCode local MCP Server "${id}" must reference its executable canonical workspace Asset.`);
      if (candidate.environment !== undefined
        && (!isRecord(candidate.environment)
          || Object.entries(candidate.environment).some(([key, entryValue]) => key.trim().length === 0 || typeof entryValue !== 'string'))) {
        report(context, 'OPENCODE_MCP_ENVIRONMENT_INVALID', `OpenCode local MCP Server "${id}" environment must map non-empty names to strings.`);
      }
    } else if (candidate.type === 'remote') {
      try {
        /** remote URL 只接受无内联凭据的 HTTP(S) 地址。 */
        if (typeof candidate.url !== 'string')
          throw new TypeError('URL must be a string.');
        /** url 是已经通过字符串边界的标准 URL 解析结果。 */
        const url = new URL(candidate.url);
        if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username !== '' || url.password !== '')
          throw new TypeError('Unsafe URL.');
      } catch {
        report(context, 'OPENCODE_MCP_REMOTE_URL_INVALID', `OpenCode remote MCP Server "${id}" requires an HTTP(S) URL without credentials.`);
      }
      if (candidate.headers !== undefined
        && (!isRecord(candidate.headers)
          || Object.entries(candidate.headers).some(([key, header]) => key.trim().length === 0 || typeof header !== 'string'))) {
        report(context, 'OPENCODE_MCP_HEADERS_INVALID', `OpenCode remote MCP Server "${id}" headers must map non-empty names to strings.`);
      }
      if (candidate.oauth !== undefined) {
        if (!isRecord(candidate.oauth)) {
          report(context, 'OPENCODE_MCP_OAUTH_INVALID', `OpenCode remote MCP Server "${id}" oauth must be an object.`);
        } else {
          for (const field of Object.keys(candidate.oauth)) {
            if (field !== 'scope')
              report(context, 'OPENCODE_MCP_OAUTH_FIELD_UNKNOWN', `Unknown OpenCode MCP OAuth field "${field}" on Server "${id}".`);
          }
          if (candidate.oauth.scope !== undefined
            && (typeof candidate.oauth.scope !== 'string' || candidate.oauth.scope.trim().length === 0)) {
            report(context, 'OPENCODE_MCP_OAUTH_INVALID', `OpenCode remote MCP Server "${id}" oauth.scope must be a non-empty string.`);
          }
        }
      }
    } else {
      report(context, 'OPENCODE_MCP_SERVER_TYPE_INVALID', `OpenCode MCP Server "${id}" must be local or remote.`);
    }
  }
}

/**
 * 校验 OpenCode workspace 只包含受控资源和按需配置。
 *
 * @param context Platform 提供的已物化候选交付单元。
 */
export async function validateOpenCodePackage(context: PlatformValidateContext): Promise<void> {
  /** 当前候选 Workspace Package 的规范 Asset 路径集合。 */
  const assets = new Set(context.candidate.unit.assets.map(asset => asset.path));
  if (assets.has('.cursor-plugin/plugin.json') || assets.has('.claude-plugin/plugin.json')) {
    report(context, 'OPENCODE_PLUGIN_MANIFEST_FORBIDDEN', 'OpenCode workspace delivery must not generate a Plugin manifest.');
  }
  if (assets.has('package.json'))
    report(context, 'OPENCODE_PACKAGE_JSON_FORBIDDEN', 'OpenCode workspace delivery must not generate a generic package.json.');
  if (!assets.has(WORKSPACE_CONFIG_PATH))
    return;
  try {
    /** 按需配置必须是只包含 Platform/Extension 所有字段的 JSON 对象。 */
    const value: unknown = JSON.parse(await fs.readFile(path.join(context.candidate.root, WORKSPACE_CONFIG_PATH), 'utf8'));
    if (!isRecord(value))
      throw new TypeError('Config is not an object.');
    /** field 表示当前配置根字段，用于阻止任意消费工程配置注入。 */
    for (const field of Object.keys(value)) {
      if (!CONFIG_FIELDS.has(field))
        report(context, 'OPENCODE_CONFIG_FIELD_UNKNOWN', `Unknown generated OpenCode config field "${field}".`);
    }
    if (value.mcp !== undefined) {
      if (!isRecord(value.mcp))
        report(context, 'OPENCODE_MCP_CONFIG_INVALID', 'opencode.json.mcp must be an object.');
      else
        await validateMcp(context, assets, value.mcp);
    }
  } catch {
    report(context, 'OPENCODE_CONFIG_READ_FAILED', 'opencode.json must contain a valid JSON object.');
  }
}
