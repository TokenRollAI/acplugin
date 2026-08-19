/** Hooks Extension 的稳定包名、配置名和诊断身份。 */
export const EXTENSION_NAME = '@tokenroll/acplugin-extension-hooks';

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

/** Hook 一级目录接受的小写 kebab-case 格式。 */
export const HOOK_ID_PATTERN: RegExp = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Platform ID 接受的小写 kebab-case 格式。 */
export const PLATFORM_ID_PATTERN: RegExp = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** 单个 Handler 接受和输出的最大 JSON 字节数。 */
export const MAX_HOOK_IO_BYTES: number = 1024 * 1024;
