import type { Command } from 'commander';
import { addProjectOptions, type ProjectCliOptions } from '../options.js';
import { runPipeline } from './pipeline.js';

/** 注册 inspect 命令的薄参数适配。 */
export function registerInspectCommand(program: Command): void {
  addProjectOptions(program.command('inspect').description('Inspect all selected Platform packages'), 'production')
    .action((options: ProjectCliOptions) => runPipeline('inspect', options));
}
