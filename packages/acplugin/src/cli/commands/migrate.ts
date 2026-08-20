import process from 'node:process';
import type { Command } from 'commander';
import { writeFailure } from '../output.js';

/** Commander 解析后的 Migration 选项。 */
interface MigrateCliOptions {
  readonly path?: string;
  readonly plugin?: string;
  readonly all?: boolean;
  readonly name?: string;
  readonly description?: string;
  readonly dryRun?: boolean;
  readonly strict?: boolean;
  readonly json?: boolean;
}

/** 注册隔离 Migration 命令；实现继续只通过动态 import 加载。 */
export function registerMigrateCommand(program: Command): void {
  program.command('migrate')
    .description('Migrate a legacy Claude project or plugin into canonical source')
    .argument('<source>', 'Local path or supported GitHub source')
    .argument('[destination]', 'New destination directory')
    .option('-p, --path <subpath>', 'Sub-path inside a GitHub repository')
    .option('--plugin <name>', 'Select one marketplace plugin')
    .option('--all', 'Migrate all marketplace plugins')
    .option('--name <name>', 'Canonical plugin name for project input')
    .option('--description <description>', 'Canonical plugin description for project input')
    .option('--dry-run', 'Generate and validate in temporary storage without committing')
    .option('--strict', 'Fail when any resource is degraded or unmapped')
    .option('--json', 'Emit one stable JSON report on stdout')
    .action(async (source: string, destination: string | undefined, options: MigrateCliOptions) => {
      try {
        // Migration 动态导入保持在独立 chunk，不进入正常配置与构建启动路径。
        const { migrate } = await import('../../migration/index.js');
        /** 旧工程转换产生的结构化迁移报告。 */
        const report = await migrate({
          source,
          ...(destination === undefined ? {} : { destination }),
          ...(options.path === undefined ? {} : { subPath: options.path }),
          ...(options.plugin === undefined ? {} : { plugin: options.plugin }),
          ...(options.all === undefined ? {} : { all: options.all }),
          ...(options.name === undefined ? {} : { name: options.name }),
          ...(options.description === undefined ? {} : { description: options.description }),
          ...(options.dryRun === undefined ? {} : { dryRun: options.dryRun }),
          ...(options.strict === undefined ? {} : { strict: options.strict }),
        });
        if (options.json)
          process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
        else
          process.stdout.write(`Migration ${report.success ? 'succeeded' : 'failed'}: ${report.items.length} resource(s)\n`);
        if (!report.success)
          process.exitCode = 1;
      } catch (error) {
        writeFailure('migrate', error, options.json, false);
        process.exitCode = 1;
      }
    });
}
