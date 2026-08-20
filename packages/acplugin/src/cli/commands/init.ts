import process from 'node:process';
import type { Command } from 'commander';
import { initializeProject, type InitPlatformId } from '../../index.js';
import { writeFailure } from '../output.js';

/** Commander 解析后的 init 选项。 */
interface InitCliOptions {
  readonly yes?: boolean;
  readonly name?: string;
  readonly displayName?: string;
  readonly description?: string;
  readonly platform?: InitPlatformId[];
  readonly hooks?: boolean;
  readonly mcp?: boolean;
  readonly nodeRuntime?: boolean;
  readonly install?: boolean;
  readonly json?: boolean;
}

/** 注册 init 命令及其脚手架 facade 适配。 */
export function registerInitCommand(program: Command): void {
  program.command('init')
    .description('Create an opinionated canonical plugin project')
    .argument('[directory]', 'New or empty destination directory')
    .option('-y, --yes', 'Accept deterministic defaults')
    .option('--name <name>', 'Plugin machine name')
    .option('--display-name <name>', 'Plugin display name')
    .option('--description <description>', 'Plugin description')
    .option('--platform <platforms...>', 'Select one or more configured Platforms')
    .option('--hooks', 'Enable the official Hooks Extension')
    .option('--mcp', 'Enable the official MCP Extension')
    .option('--node-runtime', 'Generate a built-in Node Runtime entry')
    .option('--install', 'Run pnpm install after scaffolding')
    .option('--json', 'Emit one stable JSON result on stdout')
    .action(async (directory: string | undefined, options: InitCliOptions) => {
      try {
        /** init 参数与交互结果共同生成的脚手架结果。 */
        const result = await initializeProject({
          ...(directory === undefined ? {} : { directory }),
          ...(options.yes === undefined ? {} : { yes: options.yes }),
          ...(options.name === undefined ? {} : { name: options.name }),
          ...(options.displayName === undefined ? {} : { displayName: options.displayName }),
          ...(options.description === undefined ? {} : { description: options.description }),
          ...(options.platform === undefined ? {} : { platforms: options.platform }),
          ...(options.hooks === undefined ? {} : { hooks: options.hooks }),
          ...(options.mcp === undefined ? {} : { mcp: options.mcp }),
          ...(options.nodeRuntime === undefined ? {} : { nodeRuntime: options.nodeRuntime }),
          ...(options.install === undefined ? {} : { install: options.install }),
        });
        if (options.json)
          process.stdout.write(`${JSON.stringify({ schemaVersion: 2, success: true, ...result }, null, 2)}\n`);
        else
          process.stdout.write(`Created ${result.directory}\nNext: cd ${result.directory} && pnpm install && pnpm build\n`);
        if (options.install && !result.installed)
          process.exitCode = 1;
      } catch (error) {
        writeFailure('init', error, options.json, false);
        process.exitCode = 1;
      }
    });
}
