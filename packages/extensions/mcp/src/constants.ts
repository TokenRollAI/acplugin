/** MCP Extension 的稳定包名、配置名和诊断身份。 */
export const EXTENSION_NAME = '@tokenroll/acplugin-extension-mcp';

/** Claude Code 官方 Platform 的稳定 ID。 */
export const CLAUDE_CODE_PLATFORM_ID = 'claude-code';

/** Codex 官方 Platform 的稳定 ID。 */
export const CODEX_PLATFORM_ID = 'codex';

/** Cursor 官方 Platform 的稳定 ID。 */
export const CURSOR_PLATFORM_ID = 'cursor';

/** Antigravity 官方 Platform 的稳定 ID。 */
export const ANTIGRAVITY_PLATFORM_ID = 'antigravity';

/** OpenCode 官方 Platform 的稳定 ID。 */
export const OPENCODE_PLATFORM_ID = 'opencode';

/** Pi 官方 Platform 的稳定 ID。 */
export const PI_PLATFORM_ID = 'pi';

/** Claude Code 与 Codex Platform 共同公开的 Plugin Manifest 逻辑 ID。 */
export const PLUGIN_MANIFEST_ID = 'plugin-manifest';

/** 默认平台共同使用的 MCP 配置文件路径。 */
export const MCP_MANIFEST_PATH = '.mcp.json';

/** MCP 一级目录接受的小写 kebab-case 格式。 */
export const MCP_ID_PATTERN: RegExp = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** MCP 环境变量引用接受的可移植名称格式。 */
export const ENV_NAME_PATTERN: RegExp = /^[A-Za-z_][A-Za-z0-9_]*$/;
