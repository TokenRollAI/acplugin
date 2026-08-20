import type { Command } from 'commander';
import { addProjectOptions, type ProjectCliOptions } from '../options.js';
import { runPipeline } from './pipeline.js';

/** 注册 build 命令的薄参数适配。 */
export function registerBuildCommand(program: Command): void {
  addProjectOptions(program.command('build').description('Build and atomically commit selected Platforms'), 'production')
    .action((options: ProjectCliOptions) => runPipeline('build', options));
}
