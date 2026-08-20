import process from 'node:process';
import { Command, CommanderError } from 'commander';
import { ACPLUGIN_VERSION } from '../index.js';
import { registerBuildCommand } from './commands/build.js';
import { registerDevCommand } from './commands/dev.js';
import { registerInitCommand } from './commands/init.js';
import { registerInspectCommand } from './commands/inspect.js';
import { registerMigrateCommand } from './commands/migrate.js';
import { registerValidateCommand } from './commands/validate.js';

/** 构造完整 Commander 命令树，但不读取 argv 或退出进程。 */
export function createCli(): Command {
  /** 注册全局元数据和错误处理策略的 CLI 根命令。 */
  const program = new Command()
    .name('acplugin')
    .description('Build canonical AI plugin deliveries for configured Platforms')
    .version(ACPLUGIN_VERSION)
    .showHelpAfterError()
    .exitOverride();

  registerInitCommand(program);
  registerMigrateCommand(program);
  registerValidateCommand(program);
  registerInspectCommand(program);
  registerBuildCommand(program);
  registerDevCommand(program);
  return program;
}

/** 解析 CLI 参数并把使用错误与框架内部错误映射为稳定退出码。 */
export async function main(argv: readonly string[] = process.argv): Promise<void> {
  /** 当前调用独占的 Commander 命令树。 */
  const program = createCli();
  if (argv.length <= 2) {
    program.outputHelp();
    return;
  }
  try {
    /** `--` 之前用于识别已移除参数的真实选项候选。 */
    const argumentsAfterBinary = argv.slice(2);
    /** Commander option 终止符位置。 */
    const terminator = argumentsAfterBinary.indexOf('--');
    /** 不包含位置参数文本的选项扫描范围。 */
    const scanned = terminator === -1 ? argumentsAfterBinary : argumentsAfterBinary.slice(0, terminator);
    if (scanned.some(argument => argument === '--target' || argument === '-t' || argument.startsWith('--target='))) {
      program.error('option \'--target\' has been removed; use \'--platform <id...>\' instead', {
        exitCode: 2,
        code: 'acplugin.legacyTarget',
      });
    }
    await program.parseAsync(argv);
  } catch (error) {
    if (error instanceof CommanderError) {
      if (error.code === 'commander.helpDisplayed' || error.code === 'commander.version')
        return;
      process.exitCode = 2;
      return;
    }
    process.stderr.write('internal error: the CLI failed inside the framework\n');
    process.exitCode = 2;
  }
}
