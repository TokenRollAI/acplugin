import { execFile } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

/** Promise 化的子进程执行器，用于消费真实 CLI JSON。 */
const execute = promisify(execFile);
/** 当前仓库根目录。 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** Playground 工程根目录。 */
const playground = path.join(root, 'packages/playground');
/** 已构建的真实 acplugin CLI 入口。 */
const cli = path.join(root, 'packages/acplugin/dist/cli.mjs');

/** 在 Playground 报告不满足预期时使用稳定消息失败。 */
function assert(condition, message) {
  if (!condition)
    throw new Error(message);
}

/** Playground 明确接受的 Codex Agent 降级及其依赖传播。 */
const expectedDegradations = new Set([
  'agent:investigator\0agent.capabilities',
  'agent:investigator\0agent.model',
  'agent:investigator\0component',
  'agent:recorder\0agent.capabilities',
  'agent:recorder\0agent.model',
  'agent:recorder\0component',
  'agent:reflector\0agent.capabilities',
  'agent:reflector\0agent.model',
  'agent:reflector\0component',
  'command:prune\0dependency:agent:reflector',
  'command:update\0dependency:agent:investigator',
  'command:upgrade\0dependency:agent:recorder',
]);

/** 判断 relaxed 诊断是否使用预期的稳定结构，而不依赖人类可读文案。 */
function isExpectedDiagnostic(diagnostic) {
  return diagnostic.code === 'COMPATIBILITY_RELAXED'
    && diagnostic.platform === 'codex'
    && diagnostic.phase === 'compatibility'
    && diagnostic.severity === 'warning';
}

/** 读取指定 Platform 主 DeliveryUnit 的 Artifact 路径集合。 */
function artifactsFor(report, platform) {
  /** 当前 Platform 唯一主交付单元。 */
  const unit = report.deliveryUnits.find(candidate => candidate.platform === platform && candidate.role === 'primary');
  assert(unit !== undefined, `Playground report is missing the ${platform} primary DeliveryUnit.`);
  return new Set(unit.artifacts.map(artifact => artifact.path));
}

/** 运行真实 validate，并校验 relaxed 白名单与关键交付资源。 */
async function main() {
  /** CLI 稳定 JSON 模式产生的标准输出。 */
  const { stdout } = await execute(process.execPath, [cli, 'validate', '--json'], {
    cwd: playground,
    maxBuffer: 4 * 1024 * 1024,
  });
  /** 已解析的公开 BuildResult 报告。 */
  const report = JSON.parse(stdout);
  assert(report.success === true, 'Playground validation did not succeed.');
  assert(report.committed === false, 'Playground validation unexpectedly committed output.');
  assert(report.diagnostics.every(isExpectedDiagnostic), 'Playground report contains an unexpected diagnostic.');
  assert(report.compatibility.every(entry => entry.level !== 'unsupported'), 'Playground report contains unsupported compatibility.');
  /** 报告中实际出现的全部 degraded 结构化兼容性键。 */
  const degradedEntries = report.compatibility.filter(entry => entry.level === 'degraded');
  /** 去重后的 subject/capability 键，用于拒绝未声明的降级。 */
  const actualDegradations = new Set(degradedEntries.map(entry => `${entry.subject}\0${entry.capability}`));
  assert(degradedEntries.length === expectedDegradations.size, 'Playground report contains an unexpected number of degradations.');
  assert(actualDegradations.size === expectedDegradations.size, 'Playground report contains an unexpected number of degradations.');
  for (const degradation of expectedDegradations)
    assert(actualDegradations.has(degradation), `Playground report is missing expected degradation ${degradation.replace('\0', ' / ')}.`);
  assert(report.diagnostics.length === expectedDegradations.size, 'Playground diagnostics do not match the accepted degradations.');

  for (const platform of ['claude-code', 'codex']) {
    /** 当前 Platform 交付单元中的全部稳定 Artifact 路径。 */
    const artifacts = artifactsFor(report, platform);
    for (const reference of ['frontier', 'transaction', 'reflection-promotion', 'compact-continuation']) {
      assert(artifacts.has(`skills/llmdoc/references/${reference}.md`), `${platform} is missing Skill reference ${reference}.`);
    }
    for (const hook of ['session-start', 'pre-compact', 'stop']) {
      assert(artifacts.has(`hooks/${hook}/handler.mjs`), `${platform} is missing Hook handler ${hook}.`);
      assert(artifacts.has(`hooks/${hook}/wire.mjs`), `${platform} is missing Hook wire ${hook}.`);
    }
    assert(artifacts.has('resources/templates/domain.md'), `${platform} is missing Public templates.`);
    assert(artifacts.has('runtime/README.md'), `${platform} is missing the runtime boundary document.`);
    assert(artifacts.has('schemas/README.md'), `${platform} is missing the schema boundary document.`);
    assert(artifacts.has('upgrade/README.md'), `${platform} is missing the upgrade boundary document.`);
  }
}

/** 作为脚本入口执行 Playground 结构与兼容性白名单检查。 */
await main();
