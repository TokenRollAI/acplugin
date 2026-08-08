import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { checkbox, input } from '@inquirer/prompts';

/** 控制 `acplugin init` 的交互方式、工程元数据和可选官方 Extension。 */
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

/** 无交互脚手架默认启用的正式支持 Platform。 */
const DEFAULT_PLATFORMS: readonly InitPlatformId[] = ['claude-code', 'codex'];

/** 每个官方 Platform 的独立 package 与配置工厂导出名。 */
const PLATFORM_PACKAGES: Readonly<Record<InitPlatformId, { packageName: string; factory: string }>> = {
  'claude-code': { packageName: '@tokenroll/acplugin-platform-claude-code', factory: 'claudeCode' },
  'codex': { packageName: '@tokenroll/acplugin-platform-codex', factory: 'codex' },
  'cursor': { packageName: '@tokenroll/acplugin-platform-cursor', factory: 'cursor' },
  'antigravity': { packageName: '@tokenroll/acplugin-platform-antigravity', factory: 'antigravity' },
  'opencode': { packageName: '@tokenroll/acplugin-platform-opencode', factory: 'openCode' },
  'pi': { packageName: '@tokenroll/acplugin-platform-pi', factory: 'pi' },
};

/** Plugin 名称接受的小写 kebab-case 格式。 */
const NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * 从目标目录名称派生合法且稳定的默认 Plugin 名称。
 *
 * @param directory 新工程绝对路径。
 * @returns 小写 kebab-case 名称，无法提取字符时回退为 `my-plugin`。
 */
function defaultName(directory: string): string {
  return path.basename(directory)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') || 'my-plugin';
}

/**
 * 把 kebab-case Plugin 名称转换为默认英文展示名称。
 *
 * @param name 已验证的 Plugin 机器名称。
 * @returns 每个名称片段首字母大写的文本。
 */
function defaultDisplayName(name: string): string {
  return name.split('-').map(part => part.charAt(0).toUpperCase() + part.slice(1)).join(' ');
}

/**
 * 确认脚手架目标不存在或是空的普通目录。
 *
 * @param directory 待写入工程的绝对目录。
 * @throws 目标是符号链接、非目录或非空目录时抛出异常。
 */
async function assertDestination(directory: string): Promise<void> {
  try {
    /** 已存在目标的文件类型和符号链接状态。 */
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new InitError('destination exists and is not a regular directory');
    if ((await fs.readdir(directory)).length > 0)
      throw new InitError('destination directory is not empty');
  } catch /** error 保存当前操作捕获的异常，供本阶段转换或恢复。 */ (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return;
    throw error;
  }
}

/**
 * 生成使用顶层元数据和可选官方 Extension 的 `acplugin.config.ts`。
 *
 * @param metadata 新工程的 Plugin 元数据与 Extension 选择。
 * @returns 可直接写入磁盘的 TypeScript 配置源码。
 */
function configSource(metadata: {
  name: string;
  displayName: string;
  description: string;
  platforms: readonly InitPlatformId[];
  hooks: boolean;
  mcp: boolean;
}): string {
  /** 配置入口以及每个选中 Platform 的独立 package 默认导入。 */
  const imports = [
    `import { defineConfig } from '@tokenroll/acplugin';`,
    ...metadata.platforms.map((platform) => {
      /** 当前官方 Platform 的 package 名和本地工厂名。 */
      const definition = PLATFORM_PACKAGES[platform];
      return `import ${definition.factory} from '${definition.packageName}';`;
    }),
  ];
  /** 写入配置 `extensions` 数组的初始化表达式。 */
  const extensions: string[] = [];
  if (metadata.hooks) {
    imports.push(`import hooks from '@tokenroll/acplugin-extension-hooks';`);
    extensions.push('hooks()');
  }
  if (metadata.mcp) {
    imports.push(`import mcp from '@tokenroll/acplugin-extension-mcp';`);
    extensions.push('mcp()');
  }
  return `${imports.join('\n')}

export default defineConfig({
  name: ${JSON.stringify(metadata.name)},
  version: '0.1.0',
  description: ${JSON.stringify(metadata.description)},
  displayName: ${JSON.stringify(metadata.displayName)},
  platforms: [${metadata.platforms.map(platform => `${PLATFORM_PACKAGES[platform].factory}()`).join(', ')}],${extensions.length
    ? `
  extensions: [${extensions.join(', ')}],`
    : ''}
});
`;
}

/**
 * 生成仅包含工程开发依赖和标准命令的私有 package.json。
 *
 * @param name Plugin 机器名称。
 * @param platforms 需要加入的独立官方 Platform 依赖。
 * @param hooks 是否加入官方 Hooks Extension 依赖。
 * @param mcp 是否加入官方 MCP Extension 依赖。
 * @returns 以换行结尾的格式化 JSON。
 */
function packageSource(name: string, platforms: readonly InitPlatformId[], hooks: boolean, mcp: boolean): string {
  /** 根据 Extension 选择动态扩展的开发依赖映射。 */
  const devDependencies: Record<string, string> = {
    '@tokenroll/acplugin': '^1.0.0',
    '@types/node': '^20.19.0',
    'typescript': '^7.0.2',
  };
  for (const platform of platforms)
    devDependencies[PLATFORM_PACKAGES[platform].packageName] = '^1.0.0';
  if (hooks)
    devDependencies['@tokenroll/acplugin-extension-hooks'] = '^1.0.0';
  if (mcp)
    devDependencies['@tokenroll/acplugin-extension-mcp'] = '^1.0.0';
  return `${JSON.stringify({
    name,
    version: '0.1.0',
    private: true,
    type: 'module',
    packageManager: 'pnpm@10.34.5',
    engines: { node: '^20.19.0 || ^22.13.0 || >=23.5.0' },
    scripts: {
      dev: 'acplugin dev',
      validate: 'acplugin validate',
      inspect: 'acplugin inspect',
      build: 'acplugin build',
      typecheck: 'tsc --noEmit',
    },
    devDependencies,
  }, null, 2)}\n`;
}

/**
 * 在新工程中运行 pnpm install，并把子进程失败转换为布尔结果。
 *
 * @param directory 新工程绝对目录。
 * @returns pnpm 以零退出码结束时返回 true。
 */
async function installDependencies(directory: string): Promise<boolean> {
  return new Promise((resolve) => {
    /** 继承当前终端输入输出的 pnpm 子进程。 */
    const child = spawn('pnpm', ['install'], { cwd: directory, stdio: 'inherit' });
    child.once('error', () => resolve(false));
    child.once('exit', code => resolve(code === 0));
  });
}

/**
 * 交互式或无交互地创建一个最小、可构建的规范 Plugin 工程。
 *
 * @param options 目标目录、元数据、Extension 和依赖安装选项。
 * @returns 创建文件、启用 Extension 与安装状态。
 */
export async function initializeProject(options: InitOptions): Promise<InitResult> {
  /** 解析相对目标目录使用的绝对工作目录。 */
  const cwd = path.resolve(options.cwd ?? process.cwd());
  /** CLI 参数或交互提示提供的原始目录值。 */
  let directoryValue = options.directory;
  if (!directoryValue) {
    if (options.yes || !process.stdin.isTTY)
      throw new InitError('A destination directory is required in non-interactive mode; pass "." explicitly for the current directory.');
    directoryValue = await input({ message: 'Project directory', default: 'my-plugin' });
  }
  /** 已解析并即将接受脚手架文件的绝对目录。 */
  const directory = path.resolve(cwd, directoryValue);
  await assertDestination(directory);

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
  /** platform 表示当前需要验证和稳定去重的脚手架 Platform。 */
  for (const platform of platforms) {
    if (!Object.hasOwn(PLATFORM_PACKAGES, platform))
      throw new InitError(`Unknown init Platform "${platform}".`);
    if (seenPlatforms.has(platform))
      throw new InitError(`Duplicate init Platform "${platform}".`);
    seenPlatforms.add(platform);
  }

  /** 新工程是否启用 Hooks Extension。 */
  let hooksEnabled = options.hooks ?? false;
  /** 新工程是否启用 MCP Extension。 */
  let mcpEnabled = options.mcp ?? false;
  if (!options.yes && process.stdin.isTTY && options.hooks === undefined && options.mcp === undefined) {
    /** 用户在统一 Extension 复选提示中选择的功能。 */
    const selected = await checkbox({
      message: 'Optional Extensions',
      choices: [
        { name: 'Hooks', value: 'hooks' },
        { name: 'MCP', value: 'mcp' },
      ],
    });
    hooksEnabled = selected.includes('hooks');
    mcpEnabled = selected.includes('mcp');
  }

  /** 默认 Skill 的目录，也是 mkdir 一次创建整个工程树的锚点。 */
  const skillDirectory = path.join(directory, 'src', 'skills', name);
  await fs.mkdir(skillDirectory, { recursive: true });
  if (hooksEnabled)
    await fs.mkdir(path.join(directory, 'src', 'hooks'), { recursive: true });
  if (mcpEnabled)
    await fs.mkdir(path.join(directory, 'src', 'mcp'), { recursive: true });
  /** 初始化结果中稳定呈现的全部脚手架文件路径。 */
  const files = [
    'acplugin.config.ts',
    'package.json',
    'tsconfig.json',
    '.gitignore',
    `src/skills/${name}/SKILL.md`,
  ];
  // 使用 `wx` 并行写入，既减少脚手架耗时，也避免意外覆盖并发创建的文件。
  await Promise.all([
    fs.writeFile(path.join(directory, 'acplugin.config.ts'), configSource({ name, displayName, description: description.trim(), platforms, hooks: hooksEnabled, mcp: mcpEnabled }), { flag: 'wx' }),
    fs.writeFile(path.join(directory, 'package.json'), packageSource(name, platforms, hooksEnabled, mcpEnabled), { flag: 'wx' }),
    fs.writeFile(path.join(directory, 'tsconfig.json'), `${JSON.stringify({
      compilerOptions: {
        target: 'ES2022',
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        strict: true,
        noEmit: true,
        types: ['node'],
        skipLibCheck: true,
      },
      include: ['acplugin.config.ts', 'src/**/*.ts'],
    }, null, 2)}\n`, { flag: 'wx' }),
    fs.writeFile(path.join(directory, '.gitignore'), 'node_modules\ndist\n', { flag: 'wx' }),
    fs.writeFile(path.join(skillDirectory, 'SKILL.md'), `---
description: Describe when and why to use ${displayName}.
---
Replace this text with the focused workflow ${displayName} should perform.
`, { flag: 'wx' }),
  ]);

  /** 仅在用户显式请求时执行的依赖安装结果。 */
  const installed = options.install ? await installDependencies(directory) : false;
  return {
    directory: path.relative(cwd, directory) || '.',
    files,
    platforms,
    extensions: [
      ...(hooksEnabled ? ['@tokenroll/acplugin-extension-hooks'] : []),
      ...(mcpEnabled ? ['@tokenroll/acplugin-extension-mcp'] : []),
    ],
    installed,
  };
}
