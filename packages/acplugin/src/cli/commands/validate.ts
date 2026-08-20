import type { Command } from 'commander';
import { addProjectOptions, type ProjectCliOptions } from '../options.js';
import { runPipeline } from './pipeline.js';

/** 注册 validate 命令的薄参数适配。 */
export function registerValidateCommand(program: Command): void {
  addProjectOptions(program.command('validate').description('Validate all selected Platform packages'), 'production')
    .action((options: ProjectCliOptions) => runPipeline('validate', options));
}
