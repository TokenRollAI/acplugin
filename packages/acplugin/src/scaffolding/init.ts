import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  InitError,
  resolveInitAnswers,
  resolveInitDestination,
  type InitOptions,
  type InitResult,
} from './prompts.js';
import { createScaffoldTemplates } from './templates.js';

export { InitError } from './prompts.js';
export type { InitOptions, InitPlatformId, InitResult } from './prompts.js';

/** 确认脚手架目标不存在或是空的普通目录。 */
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

/** 在新工程中运行 pnpm install，并把子进程失败转换为布尔结果。 */
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
  /** 目录先独立解析和验证，保持其他交互不会在无效目标上发生。 */
  const destination = await resolveInitDestination(options);
  await assertDestination(destination.directory);
  /** 所有模板输入都已应用默认值并通过提示层验证。 */
  const answers = await resolveInitAnswers(options, destination.directory);

  /** 默认 Skill 的目录，也是 mkdir 一次创建整个工程树的锚点。 */
  const skillDirectory = path.join(destination.directory, 'src', 'skills', answers.name);
  await fs.mkdir(skillDirectory, { recursive: true });
  if (answers.hooks)
    await fs.mkdir(path.join(destination.directory, 'src', 'hooks'), { recursive: true });
  if (answers.mcp)
    await fs.mkdir(path.join(destination.directory, 'src', 'mcp'), { recursive: true });
  if (answers.nodeRuntime)
    await fs.mkdir(path.join(destination.directory, 'src', 'runtime'), { recursive: true });

  /** 模板模块唯一确定文件顺序和生成字节。 */
  const templates = createScaffoldTemplates(answers);
  /** 使用 `wx` 并行写入，既减少脚手架耗时，也避免覆盖并发创建的文件。 */
  await Promise.all(templates.map(template => fs.writeFile(
    path.join(destination.directory, ...template.path.split('/')),
    template.content,
    { flag: 'wx' },
  )));

  /** 仅在用户显式请求时执行的依赖安装结果。 */
  const installed = options.install ? await installDependencies(destination.directory) : false;
  return {
    directory: path.relative(destination.cwd, destination.directory) || '.',
    files: templates.map(template => template.path),
    platforms: answers.platforms,
    extensions: [
      ...(answers.hooks ? ['@tokenroll/acplugin-extension-hooks'] : []),
      ...(answers.mcp ? ['@tokenroll/acplugin-extension-mcp'] : []),
    ],
    installed,
  };
}
