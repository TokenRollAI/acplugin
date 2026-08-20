import process from 'node:process';
import {
  ProjectConfigError,
  serializeBuildReport,
  type BuildReport,
} from '../index.js';

/** CLI 边界失败使用的脱敏诊断。 */
interface CliFailureDiagnostic {
  readonly code: string;
  readonly severity: 'error' | 'warning';
  readonly message: string;
  readonly phase: string;
}

/** 尚未产生 BuildReport 时使用的最小 CLI 失败报告。 */
interface CliFailureReport {
  readonly schemaVersion: 2;
  readonly command: string;
  readonly diagnostics: readonly CliFailureDiagnostic[];
  readonly success: false;
}

/** 按机器或人类可读模式输出完整 Kernel v2 报告。 */
export function writeReport(report: BuildReport, json: boolean | undefined): void {
  if (json) {
    process.stdout.write(serializeBuildReport(report));
    return;
  }
  /** 普通文本摘要使用的稳定状态词。 */
  const status = report.success ? 'success' : 'failed';
  /** 本次真正选中的 Platform ID。 */
  const selected = report.platforms.filter(platform => platform.selected).map(platform => platform.id);
  process.stdout.write(`${report.command}: ${status} (${selected.join(', ')})\n`);
  if (report.command === 'inspect') {
    for (const component of report.components)
      process.stdout.write(`component ${component.kind}/${component.id}\n`);
    for (const runtime of report.runtimes)
      process.stdout.write(`runtime ${runtime.id} ${runtime.kind} built:${runtime.built}\n`);
    for (const extension of report.extensions)
      process.stdout.write(`extension ${extension.id} resources:${extension.discovered}\n`);
    for (const platform of report.platforms)
      process.stdout.write(`platform ${platform.id} selected:${platform.selected} success:${platform.success} packages:${platform.packageIds.join(',')}\n`);
    for (const unit of report.packages) {
      process.stdout.write(`package ${unit.platform}/${unit.id} ${unit.role}:${unit.type}\n`);
      for (const asset of unit.assets)
        process.stdout.write(`  asset ${asset.path} ${asset.owner} ${asset.mode.toString(8)} ${asset.size} ${asset.sha256}\n`);
    }
    for (const entry of report.compatibility)
      process.stdout.write(`compatibility ${entry.platform} ${entry.subject}/${entry.capability} ${entry.level}: ${entry.reason}\n`);
    for (const entry of report.metadata)
      process.stdout.write(`metadata ${entry.platform} ${entry.field} ${entry.disposition}: ${entry.reason}\n`);
  }
  for (const diagnostic of report.diagnostics)
    process.stderr.write(`${diagnostic.severity} ${diagnostic.code}: ${diagnostic.message}\n`);
  for (const entry of report.compatibility) {
    if (entry.level === 'degraded' || entry.level === 'unsupported')
      process.stderr.write(`warning ${entry.platform} ${entry.subject}: ${entry.reason}\n`);
  }
}

/** JSON dev 不占用 stdout，只在 stderr 发布可观测轮次摘要。 */
export function writeDevProgress(report: BuildReport): void {
  /** 与人类可读摘要一致的稳定状态词。 */
  const status = report.success ? 'success' : 'failed';
  /** 本轮实际选中的 Platform ID。 */
  const selected = report.platforms.filter(platform => platform.selected).map(platform => platform.id);
  process.stderr.write(`${report.command}: ${status} (${selected.join(', ')})\n`);
  for (const diagnostic of report.diagnostics)
    process.stderr.write(`${diagnostic.severity} ${diagnostic.code}: ${diagnostic.message}\n`);
}

/** 将配置或命令异常转换为不泄露内部详情的 CLI 报告。 */
function failureReport(command: string, error: unknown, internal: boolean): CliFailureReport {
  /** 配置错误保留安全原因，其余异常只输出固定消息。 */
  const diagnostics: readonly CliFailureDiagnostic[] = error instanceof ProjectConfigError
    ? error.diagnostics
    : [{
        code: internal ? 'FRAMEWORK_INTERNAL_FAILED' : 'COMMAND_FAILED',
        severity: 'error',
        message: internal ? 'The command failed inside the framework.' : `${command} failed.`,
        phase: internal ? 'internal' : command,
      }];
  return { schemaVersion: 2, command, diagnostics, success: false };
}

/** 以统一 CLI 格式写出已由命令层脱敏分类的预期失败。 */
export function writeKnownFailure(
  command: string,
  diagnostics: readonly CliFailureDiagnostic[],
  json: boolean | undefined,
): void {
  /** 命令层只允许提交稳定的用户可见诊断。 */
  const report: CliFailureReport = { schemaVersion: 2, command, diagnostics, success: false };
  if (json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  for (const diagnostic of report.diagnostics)
    process.stderr.write(`${diagnostic.severity} ${diagnostic.code}: ${diagnostic.message}\n`);
}

/** 展示尚未进入 Core 报告阶段的失败。 */
export function writeFailure(command: string, error: unknown, json: boolean | undefined, internal: boolean): void {
  /** 从未知异常收敛出的安全失败报告。 */
  const report = failureReport(command, error, internal);
  writeKnownFailure(command, report.diagnostics, json);
}

/** 根据最终结构化诊断区分成功、项目失败和框架内部失败。 */
export function exitCodeFor(report: BuildReport): 0 | 1 | 2 {
  if (report.success)
    return 0;
  return report.diagnostics.some(diagnostic => diagnostic.code === 'INTERNAL_ERROR') ? 2 : 1;
}
