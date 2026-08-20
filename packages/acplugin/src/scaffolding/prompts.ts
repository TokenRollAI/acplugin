import path from 'node:path';
import { checkbox, input } from '@inquirer/prompts';
import { isInitPlatformId } from './templates.js';

/** 控制 `acplugin init` 的交互方式、工程元数据和可选框架能力。 */
export interface InitOptions {
  /** 解析目标目录的工作目录，默认为当前进程目录。 */
  cwd?: string;
  /** 新工程目录；显式传入 `.` 可使用当前目录。 */
  directory?: string;
  /** 是否跳过交互并接受确定性默认值。 */
  yes?: boolean;
  /** 可选的 Plugin 机器名称覆盖。 */
  name?: string;
  /** 可选的展示名称覆盖。 */
  displayName?: string;
  /** 可选的 Plugin 描述覆盖。 */
  description?: string;
  /** 需要显式写入配置的官方 Platform；默认 Claude Code 与 Codex。 */
  platforms?: readonly InitPlatformId[];
  /** 是否在生成配置中启用官方 Hooks Extension。 */
  hooks?: boolean;
  /** 是否在生成配置中启用官方 MCP Extension。 */
  mcp?: boolean;
  /** 是否生成 Core 内建 Node Runtime 的约定入口模板。 */
  nodeRuntime?: boolean;
  /** 是否在脚手架完成后运行 pnpm install。 */
  install?: boolean;
}

/** 初始化完成后供 CLI 文本或 JSON 输出使用的稳定结果。 */
export interface InitResult {
  /** 相对于 cwd 的新工程目录。 */
  directory: string;
  /** 脚手架创建的工程文件路径。 */
  files: readonly string[];
  /** 新工程启用的官方 Platform ID。 */
  platforms: readonly InitPlatformId[];
  /** 新工程启用的官方 Extension 包名。 */
  extensions: readonly string[];
  /** 请求安装依赖时，pnpm 是否成功退出。 */
  installed: boolean;
}

/** `init` 可以写入脚手架的六个官方 Platform ID。 */
export type InitPlatformId = 'claude-code' | 'codex' | 'cursor' | 'antigravity' | 'opencode' | 'pi';

/** 只承载可安全向 CLI 用户展示的已知脚手架输入错误。 */
export class InitError extends Error {
  /** 稳定标识内部错误类别，但不进入公开 facade。 */
  override readonly name = 'InitError';
}

/** 已解析的目标目录，在其他交互提示之前执行物理边界校验。 */
export interface InitDestination {
  readonly cwd: string;
  readonly directory: string;
}

/** 已完成默认值、交互和输入验证的脚手架选择。 */
export interface InitAnswers {
  readonly name: string;
  readonly displayName: string;
  readonly description: string;
  readonly platforms: readonly InitPlatformId[];
  readonly hooks: boolean;
  readonly mcp: boolean;
  readonly nodeRuntime: boolean;
}

/** 无交互脚手架默认启用的正式支持 Platform。 */
const DEFAULT_PLATFORMS: readonly InitPlatformId[] = ['claude-code', 'codex'];

/** Plugin 名称接受的小写 kebab-case 格式。 */
const NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** 从目标目录名称派生合法且稳定的默认 Plugin 名称。 */
function defaultName(directory: string): string {
  return path.basename(directory)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') || 'my-plugin';
}

/** 把 kebab-case Plugin 名称转换为默认英文展示名称。 */
function defaultDisplayName(name: string): string {
  return name.split('-').map(part => part.charAt(0).toUpperCase() + part.slice(1)).join(' ');
}

/** 只解析目录提示，使调用方能在其余交互前验证目标目录。 */
export async function resolveInitDestination(options: InitOptions): Promise<InitDestination> {
  /** 解析相对目标目录使用的绝对工作目录。 */
  const cwd = path.resolve(options.cwd ?? process.cwd());
  /** CLI 参数或交互提示提供的原始目录值。 */
  let directoryValue = options.directory;
  if (!directoryValue) {
    if (options.yes || !process.stdin.isTTY)
      throw new InitError('A destination directory is required in non-interactive mode; pass "." explicitly for the current directory.');
    directoryValue = await input({ message: 'Project directory', default: 'my-plugin' });
  }
  return Object.freeze({ cwd, directory: path.resolve(cwd, directoryValue) });
}

/** 解析并验证目录之后的元数据、Platform 与可选能力提示。 */
export async function resolveInitAnswers(options: InitOptions, directory: string): Promise<InitAnswers> {
  /** 根据目录名推导的默认机器名称。 */
  const suggestedName = defaultName(directory);
  /** 参数、确定性默认值或交互输入得到的最终 Plugin 名称。 */
  const name = options.name ?? (options.yes || !process.stdin.isTTY
    ? suggestedName
    : await input({ message: 'Plugin name', default: suggestedName }));
  if (!NAME_PATTERN.test(name))
    throw new InitError('Plugin name must be lowercase kebab-case.');
  /** 根据机器名称推导的默认展示名称。 */
  const suggestedDisplayName = defaultDisplayName(name);
  /** 参数、默认值或交互输入得到的最终展示名称。 */
  const displayName = options.displayName ?? (options.yes || !process.stdin.isTTY
    ? suggestedDisplayName
    : await input({ message: 'Display name', default: suggestedDisplayName }));
  /** 参数、默认值或交互输入得到的 Plugin 描述。 */
  const description = options.description ?? (options.yes || !process.stdin.isTTY
    ? `${displayName} plugin.`
    : await input({ message: 'Description', default: `${displayName} plugin.` }));
  if (description.trim() === '')
    throw new InitError('Description must not be empty.');

  /** 参数、默认值或交互复选提示得到的官方 Platform 列表。 */
  let platforms = options.platforms === undefined ? [...DEFAULT_PLATFORMS] : [...options.platforms];
  if (!options.yes && process.stdin.isTTY && options.platforms === undefined) {
    platforms = await checkbox<InitPlatformId>({
      message: 'Platforms',
      choices: [
        { name: 'Claude Code', value: 'claude-code', checked: true },
        { name: 'Codex', value: 'codex', checked: true },
        { name: 'Cursor', value: 'cursor' },
        { name: 'Antigravity', value: 'antigravity' },
        { name: 'OpenCode', value: 'opencode' },
        { name: 'Pi', value: 'pi' },
      ],
      required: true,
    });
  }
  if (platforms.length === 0)
    throw new InitError('At least one Platform must be selected.');
  /** seenPlatforms 用于拒绝重复工厂，保持配置与报告身份唯一。 */
  const seenPlatforms = new Set<InitPlatformId>();
  for (const platform of platforms) {
    if (!isInitPlatformId(platform))
      throw new InitError(`Unknown init Platform "${platform}".`);
    if (seenPlatforms.has(platform))
      throw new InitError(`Duplicate init Platform "${platform}".`);
    seenPlatforms.add(platform);
  }

  /** 新工程是否启用 Hooks Extension。 */
  let hooks = options.hooks ?? false;
  /** 新工程是否启用 MCP Extension。 */
  let mcp = options.mcp ?? false;
  /** 新工程是否生成 Core 内建 Node Runtime 模板。 */
  let nodeRuntime = options.nodeRuntime ?? false;
  if (!options.yes
    && process.stdin.isTTY
    && options.hooks === undefined
    && options.mcp === undefined
    && options.nodeRuntime === undefined) {
    /** 用户在统一可选能力提示中选择的功能。 */
    const selected = await checkbox({
      message: 'Optional Features',
      choices: [
        { name: 'Hooks', value: 'hooks' },
        { name: 'MCP', value: 'mcp' },
        { name: 'Node Runtime', value: 'node-runtime' },
      ],
    });
    hooks = selected.includes('hooks');
    mcp = selected.includes('mcp');
    nodeRuntime = selected.includes('node-runtime');
  }
  return Object.freeze({
    name,
    displayName,
    description: description.trim(),
    platforms,
    hooks,
    mcp,
    nodeRuntime,
  });
}
