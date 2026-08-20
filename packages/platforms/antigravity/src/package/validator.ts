import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { JsonValue, ValidatePackageContext } from '@tokenroll/acplugin/sdk';
import { PLUGIN_MANIFEST_PATH } from './manifest.js';

/** Antigravity validator 只消费 SDK 的最终 Package candidate Context。 */
type PlatformValidateContext = ValidatePackageContext;

/** Antigravity 当前验证过的 Hook 事件。 */
const HOOK_EVENTS = new Set(['SessionStart', 'SessionEnd', 'PreToolUse', 'PostToolUse', 'PreCompact']);

/** Antigravity Hook matcher 分组允许的字段。 */
const HOOK_GROUP_FIELDS = new Set(['matcher', 'hooks']);

/** Antigravity command Hook Handler 允许的字段。 */
const HOOK_HANDLER_FIELDS = new Set(['type', 'command']);

/** Antigravity 远程 MCP descriptor 允许的字段。 */
const MCP_SERVER_FIELDS = new Set(['type', 'url', 'headers']);

/** Extension 配置中的稳定 MCP Server ID。 */
const MCP_SERVER_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

/** JSON 对象的运行时只读索引类型。 */
type JsonRecord = Record<string, JsonValue>;

/** @returns 未知 JSON 值是否为非数组对象。 */
function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * 向 Core 提交 Antigravity 候选校验错误。
 *
 * @param context Platform validatePackage 生命周期上下文。
 * @param code 稳定诊断码。
 * @param message 不包含宿主绝对路径的错误信息。
 */
function report(
  context: PlatformValidateContext,
  code: string,
  message: string,
  fieldPath?: readonly (string | number)[],
): void {
  context.diagnostics.report({ code, severity: 'error', message, ...(fieldPath === undefined ? {} : { fieldPath }) });
}

/** 校验 Antigravity 根 `hooks.json` 的完整命令协议。 */
function validateHooks(context: PlatformValidateContext, value: unknown): void {
  if (!isRecord(value) || Object.keys(value).some(field => field !== 'hooks') || !isRecord(value.hooks)) {
    report(context, 'ANTIGRAVITY_HOOK_CONFIG_INVALID', 'hooks.json must contain only a hooks event mapping.', ['hooks']);
    return;
  }
  for (const [event, groups] of Object.entries(value.hooks)) {
    /** 当前事件在根 Hook 配置中的字段路径。 */
    const eventPath = ['hooks', event];
    if (!HOOK_EVENTS.has(event)) {
      report(context, 'ANTIGRAVITY_HOOK_EVENT_UNKNOWN', `Unknown Antigravity Hook event "${event}".`, eventPath);
      continue;
    }
    if (!Array.isArray(groups) || groups.length === 0) {
      report(context, 'ANTIGRAVITY_HOOK_GROUPS_INVALID', 'Each Hook event must contain matcher groups.', eventPath);
      continue;
    }
    for (const [groupIndex, group] of groups.entries()) {
      /** 当前 matcher 分组的字段路径。 */
      const groupPath = [...eventPath, groupIndex];
      if (!isRecord(group)) {
        report(context, 'ANTIGRAVITY_HOOK_GROUP_INVALID', 'Hook matcher groups must be objects.', groupPath);
        continue;
      }
      for (const field of Object.keys(group)) {
        if (!HOOK_GROUP_FIELDS.has(field))
          report(context, 'ANTIGRAVITY_HOOK_GROUP_FIELD_UNKNOWN', `Unknown Antigravity Hook group field "${field}".`, [...groupPath, field]);
      }
      if (group.matcher !== undefined && (typeof group.matcher !== 'string' || group.matcher.trim().length === 0))
        report(context, 'ANTIGRAVITY_HOOK_MATCHER_INVALID', 'Hook matcher must be a non-empty string.', [...groupPath, 'matcher']);
      if (!Array.isArray(group.hooks) || group.hooks.length === 0) {
        report(context, 'ANTIGRAVITY_HOOK_HANDLERS_INVALID', 'Hook groups must contain command handlers.', [...groupPath, 'hooks']);
        continue;
      }
      for (const [handlerIndex, handler] of group.hooks.entries()) {
        /** 单个 command Handler 的字段路径。 */
        const handlerPath = [...groupPath, 'hooks', handlerIndex];
        if (!isRecord(handler)) {
          report(context, 'ANTIGRAVITY_HOOK_HANDLER_INVALID', 'Hook handlers must be objects.', handlerPath);
          continue;
        }
        for (const field of Object.keys(handler)) {
          if (!HOOK_HANDLER_FIELDS.has(field))
            report(context, 'ANTIGRAVITY_HOOK_HANDLER_FIELD_UNKNOWN', `Unknown Antigravity Hook handler field "${field}".`, [...handlerPath, field]);
        }
        if (handler.type !== 'command' || typeof handler.command !== 'string' || handler.command.trim().length === 0)
          report(context, 'ANTIGRAVITY_HOOK_COMMAND_INVALID', 'Hook handlers must declare a non-empty command.', handlerPath);
      }
    }
  }
}

/** 校验 Antigravity 根 `mcp_config.json` 的 remote-only MCP 协议。 */
function validateMcp(context: PlatformValidateContext, value: unknown): void {
  if (!isRecord(value) || Object.keys(value).some(field => field !== 'mcpServers') || !isRecord(value.mcpServers)) {
    report(context, 'ANTIGRAVITY_MCP_CONFIG_INVALID', 'mcp_config.json must contain only an mcpServers mapping.', ['mcpServers']);
    return;
  }
  for (const [id, candidate] of Object.entries(value.mcpServers)) {
    /** 当前 MCP Server 的字段路径。 */
    const serverPath = ['mcpServers', id];
    if (!MCP_SERVER_ID_PATTERN.test(id) || !isRecord(candidate)) {
      report(context, 'ANTIGRAVITY_MCP_SERVER_INVALID', 'MCP Server ids must use lowercase kebab-case and map to objects.', serverPath);
      continue;
    }
    for (const field of Object.keys(candidate)) {
      if (!MCP_SERVER_FIELDS.has(field))
        report(context, 'ANTIGRAVITY_MCP_FIELD_UNKNOWN', `Unknown Antigravity MCP field "${field}".`, [...serverPath, field]);
    }
    if (candidate.type !== 'http')
      report(context, 'ANTIGRAVITY_MCP_TRANSPORT_INVALID', 'Antigravity MCP Server type must be http.', [...serverPath, 'type']);
    if (typeof candidate.url !== 'string') {
      report(context, 'ANTIGRAVITY_MCP_URL_INVALID', 'MCP url must be an HTTP(S) URL without credentials.', [...serverPath, 'url']);
    } else {
      try {
        /** 远程 MCP URL 不得包含用户信息。 */
        const url = new URL(candidate.url);
        if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username !== '' || url.password !== '')
          throw new TypeError('unsafe');
      } catch {
        report(context, 'ANTIGRAVITY_MCP_URL_INVALID', 'MCP url must be an HTTP(S) URL without credentials.', [...serverPath, 'url']);
      }
    }
    if (candidate.headers !== undefined
      && (!isRecord(candidate.headers)
        || Object.entries(candidate.headers).some(([key, header]) => key.trim().length === 0 || typeof header !== 'string'))) {
      report(context, 'ANTIGRAVITY_MCP_HEADERS_INVALID', 'MCP headers must map non-empty names to string values.', [...serverPath, 'headers']);
    }
  }
}

/**
 * 校验 Antigravity 最小 Manifest、Skill 目录和可选 Extension 配置。
 *
 * @param context Platform 提供的已物化候选交付单元。
 */
export async function validateAntigravityPackage(context: PlatformValidateContext): Promise<void> {
  /** 当前候选 Package 的规范 Asset 路径集合。 */
  const assets = new Set(context.candidate.unit.assets.map(asset => asset.path));
  try {
    /** 当前没有公开 Schema，内部严格规则只接受官方文档确认的 name。 */
    const value: unknown = JSON.parse(await fs.readFile(path.join(context.candidate.root, PLUGIN_MANIFEST_PATH), 'utf8'));
    if (value === null || typeof value !== 'object' || Array.isArray(value))
      throw new TypeError('Manifest is not an object.');
    /** 经过对象形态检查的最小 Manifest。 */
    const manifest = value as Record<string, unknown>;
    if (Object.keys(manifest).length !== 1 || typeof manifest.name !== 'string' || manifest.name.trim().length === 0)
      report(context, 'ANTIGRAVITY_MANIFEST_INVALID', 'plugin.json must contain exactly one non-empty name field.');
  } catch {
    report(context, 'ANTIGRAVITY_MANIFEST_READ_FAILED', 'plugin.json must contain the documented minimal JSON object.');
  }
  /** path 表示当前可选平台配置，存在时必须满足对应完整协议。 */
  for (const assetPath of ['hooks.json', 'mcp_config.json']) {
    if (!assets.has(assetPath))
      continue;
    try {
      /** Extension 配置由其 Contributor 生成，但仍由 Platform 做最终协议校验。 */
      const value: unknown = JSON.parse(await fs.readFile(path.join(context.candidate.root, assetPath), 'utf8'));
      if (assetPath === 'hooks.json')
        validateHooks(context, value);
      else
        validateMcp(context, value);
    } catch {
      report(context, 'ANTIGRAVITY_EXTENSION_CONFIG_INVALID', `${assetPath} must contain a JSON object.`);
    }
  }
  if ([...assets].some(asset => asset.startsWith('commands/') || asset.startsWith('agents/')))
    report(context, 'ANTIGRAVITY_UNDOCUMENTED_RESOURCE', 'Commands and Agents must be transformed into the documented skills/ tree.');
}
