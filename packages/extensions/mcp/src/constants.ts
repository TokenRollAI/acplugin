/** MCP Extension 的稳定包名、配置名和诊断身份。 */
export const EXTENSION_NAME = '@tokenroll/acplugin-extension-mcp';

/** MCP 一级目录接受的小写 kebab-case 格式。 */
export const MCP_ID_PATTERN: RegExp = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** MCP 环境变量引用接受的可移植名称格式。 */
export const ENV_NAME_PATTERN: RegExp = /^[A-Za-z_][A-Za-z0-9_]*$/;
