import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { checkbox, input } from '@inquirer/prompts';

/** 控制 `acplugin init` 的交互方式、工程元数据和可选官方 Module。 */
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
  /** 是否在生成配置中启用官方 Hooks Module。 */
  hooks?: boolean;
  /** 是否在生成配置中启用官方 MCP Module。 */
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
  /** 新工程启用的官方 Module 包名。 */
  modules: readonly string[];
  /** 请求安装依赖时，pnpm 是否成功退出。 */
  installed: boolean;
}

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
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error('destination exists and is not a regular directory');
    if ((await fs.readdir(directory)).length > 0)
      throw new Error('destination directory is not empty');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return;
    throw error;
  }
}

/**
 * 生成使用顶层元数据和可选官方 Module 的 `acplugin.config.ts`。
 *
 * @param metadata 新工程的 Plugin 元数据与 Module 选择。
 * @returns 可直接写入磁盘的 TypeScript 配置源码。
 */
function configSource(metadata: {
  name: string;
  displayName: string;
  description: string;
  hooks: boolean;
  mcp: boolean;
}): string {
  /** 配置入口必需以及由 Module 选择追加的导入语句。 */
  const imports = [`import { defineConfig } from '@tokenroll/acplugin';`];
  /** 写入配置 `modules` 数组的初始化表达式。 */
  const modules: string[] = [];
  if (metadata.hooks) {
    imports.push(`import hooks from '@tokenroll/acplugin-module-hooks';`);
    modules.push('hooks()');
  }
  if (metadata.mcp) {
    imports.push(`import mcp from '@tokenroll/acplugin-module-mcp';`);
    modules.push('mcp()');
  }
  return `${imports.join('\n')}

export default defineConfig({
  name: ${JSON.stringify(metadata.name)},
  version: '0.1.0',
  description: ${JSON.stringify(metadata.description)},
  displayName: ${JSON.stringify(metadata.displayName)},${modules.length
    ? `
  modules: [${modules.join(', ')}],`
    : ''}
});
`;
}

/**
 * 生成仅包含工程开发依赖和标准命令的私有 package.json。
 *
 * @param name Plugin 机器名称。
 * @param hooks 是否加入官方 Hooks Module 依赖。
 * @param mcp 是否加入官方 MCP Module 依赖。
 * @returns 以换行结尾的格式化 JSON。
 */
function packageSource(name: string, hooks: boolean, mcp: boolean): string {
  /** 根据 Module 选择动态扩展的开发依赖映射。 */
  const devDependencies: Record<string, string> = {
    '@tokenroll/acplugin': '^1.0.0',
    '@types/node': '^20.19.0',
    'typescript': '^7.0.2',
  };
  if (hooks)
    devDependencies['@tokenroll/acplugin-module-hooks'] = '^1.0.0';
  if (mcp)
    devDependencies['@tokenroll/acplugin-module-mcp'] = '^1.0.0';
  return `${JSON.stringify({
    name,
    version: '0.1.0',
    private: true,
    type: 'module',
    packageManager: 'pnpm@10.34.5',
    engines: { node: '>=20' },
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
 * @param options 目标目录、元数据、Module 和依赖安装选项。
 * @returns 创建文件、启用 Module 与安装状态。
 */
export async function initializeProject(options: InitOptions): Promise<InitResult> {
  /** 解析相对目标目录使用的绝对工作目录。 */
  const cwd = path.resolve(options.cwd ?? process.cwd());
  /** CLI 参数或交互提示提供的原始目录值。 */
  let directoryValue = options.directory;
  if (!directoryValue) {
    if (options.yes || !process.stdin.isTTY)
      throw new Error('A destination directory is required in non-interactive mode; pass "." explicitly for the current directory.');
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
    throw new Error('Plugin name must be lowercase kebab-case.');
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
    throw new Error('Description must not be empty.');

  /** 新工程是否启用 Hooks Module。 */
  let hooksEnabled = options.hooks ?? false;
  /** 新工程是否启用 MCP Module。 */
  let mcpEnabled = options.mcp ?? false;
  if (!options.yes && process.stdin.isTTY && options.hooks === undefined && options.mcp === undefined) {
    /** 用户在统一 Module 复选提示中选择的功能。 */
    const selected = await checkbox({
      message: 'Optional Modules',
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
    fs.writeFile(path.join(directory, 'acplugin.config.ts'), configSource({ name, displayName, description: description.trim(), hooks: hooksEnabled, mcp: mcpEnabled }), { flag: 'wx' }),
    fs.writeFile(path.join(directory, 'package.json'), packageSource(name, hooksEnabled, mcpEnabled), { flag: 'wx' }),
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
    modules: [
      ...(hooksEnabled ? ['@tokenroll/acplugin-module-hooks'] : []),
      ...(mcpEnabled ? ['@tokenroll/acplugin-module-mcp'] : []),
    ],
    installed,
  };
}
