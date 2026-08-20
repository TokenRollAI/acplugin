import { Command, Option } from 'commander';
import type { BuildMode } from '../index.js';

/** validate、inspect、build 和 dev 命令共享的 CLI 选项。 */
export interface ProjectCliOptions {
  readonly config?: string;
  readonly platform?: string[];
  readonly mode: BuildMode;
  readonly json?: boolean;
}

/** 为 Project 子命令注册一致且不覆盖配置语义的选项。 */
export function addProjectOptions(command: Command, defaultMode: BuildMode): Command {
  return command
    .option('-c, --config <path>', 'Use another project-relative TypeScript config file')
    .addOption(new Option('--platform <id...>', 'Select a subset of configured Platforms'))
    .addOption(new Option('--mode <mode>', 'Config mode').choices(['development', 'production']).default(defaultMode))
    .option('--json', 'Emit one stable JSON report on stdout');
}
