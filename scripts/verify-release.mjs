import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, URL } from 'node:url';
import { checkPackage, createPackageFromTarballData } from '@arethetypeswrong/core';
import { publint } from 'publint';

/** 当前 monorepo 根目录。 */
const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
/** 必须以统一版本手动发布并共同验证的公开包。 */
const packages = [
  { name: '@tokenroll/acplugin' },
  { name: '@tokenroll/acplugin-extension-hooks' },
  { name: '@tokenroll/acplugin-extension-mcp' },
];
/** 发布 tarball 运行时依赖中绝不能出现的私有工作区包名。 */
const privateNames = new Set([
  '@acplugin/core',
  '@acplugin/test',
  '@acplugin/platform-antigravity',
  '@acplugin/platform-claude-code',
  '@acplugin/platform-codex',
  '@acplugin/platform-cursor',
  '@acplugin/platform-opencode',
  '@acplugin/platform-pi',
]);
/** ESM-only 正式包按 ATTW esm-only Profile 有意不提供的旧/CJS 解析模式。 */
const esmOnlyIgnoredResolutions = new Set(['node10', 'node16-cjs']);

/**
 * 运行发布验证所需的子进程，并统一处理捕获输出与非零退出码。
 *
 * @param command 可执行命令。
 * @param args 独立参数数组，不经过 Shell 拼接。
 * @param cwd 子进程工作目录。
 * @param options 可选的 stdout/stderr 捕获策略。
 * @returns 子进程成功退出时的输出。
 */
function run(command, args, cwd, options = {}) {
  return new Promise((resolve, reject) => {
    /** 继承当前发布环境的验证子进程。 */
    const child = spawn(command, args, {
      cwd,
      env: process.env,
      stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    });
    /** capture 模式下累计的标准输出。 */
    let stdout = '';
    /** capture 模式下累计的标准错误。 */
    let stderr = '';
    if (options.capture) {
      child.stdout.setEncoding('utf8').on('data', chunk => stdout += chunk);
      child.stderr.setEncoding('utf8').on('data', chunk => stderr += chunk);
    }
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0)
        resolve({ stdout, stderr });
      else
        reject(new Error(`${command} ${args.join(' ')} failed with exit code ${code}.${stderr ? `\n${stderr}` : ''}`));
    });
  });
}

/**
 * 在无额外测试框架依赖的脚本中执行发布不变量断言。
 *
 * @param condition 必须成立的条件。
 * @param message 不变量失败说明。
 */
function assert(condition, message) {
  if (!condition)
    throw new Error(message);
}

/**
 * 打包一个公开工作区包，并精确识别本次新生成的 tarball。
 *
 * @param directory 临时 tarball 目录。
 * @param name 公开包名。
 * @returns 新 tarball 的绝对路径。
 */
async function tarballFor(directory, name) {
  /** 打包前目录内容，用于排除已有文件。 */
  const before = new Set(await fs.readdir(directory));
  await run('pnpm', ['--filter', name, 'pack', '--pack-destination', directory], root);
  /** 本次命令唯一新建的 tgz 文件。 */
  const created = (await fs.readdir(directory)).filter(file => file.endsWith('.tgz') && !before.has(file));
  assert(created.length === 1, `Expected one tarball for ${name}, found ${created.length}.`);
  return path.join(directory, created[0]);
}

/**
 * 检查 tarball 路径边界、源码泄漏、必需文件和私有依赖泄漏。
 *
 * @param tarball 待检查压缩包。
 * @param expectedName 预期 package.json 名称。
 * @param extractRoot 隔离解压根目录。
 * @returns 解压并读取的发布清单。
 */
async function inspectTarball(tarball, expectedName, extractRoot) {
  /** tarball 中全部归档条目。 */
  const listed = (await run('tar', ['-tzf', tarball], root, { capture: true })).stdout.trim().split('\n').filter(Boolean);
  assert(listed.every(file => file.startsWith('package/')), `${expectedName} tarball contains an entry outside package/.`);
  /** 不允许发布的源码、测试目录或 TypeScript 源文件。 */
  const leaked = listed.filter(file => /(?:^|\/)(?:src|test|__tests__)(?:\/|$)/.test(file) || /\.(?:ts|tsx)$/.test(file));
  assert(leaked.length === 0, `${expectedName} tarball leaks source/test files: ${leaked.join(', ')}`);
  assert(listed.includes('package/README.md'), `${expectedName} tarball is missing README.md.`);
  assert(listed.includes('package/LICENSE'), `${expectedName} tarball is missing LICENSE.`);
  // 本地 stdio 只在 MCP Extension 中按需加载，因此该独立入口必须随正式包发布。
  if (expectedName === '@tokenroll/acplugin-extension-mcp')
    assert(listed.includes('package/dist/bundler.mjs'), `${expectedName} tarball is missing the local stdio Bundler entry.`);

  /** 当前包独占的安全解压目录。 */
  const destination = path.join(extractRoot, expectedName.replace(/[^a-z0-9]+/gi, '-'));
  await fs.mkdir(destination, { recursive: true });
  await run('tar', ['-xzf', tarball, '-C', destination], root);
  /** tarball 内实际发布的 package.json。 */
  const manifest = JSON.parse(await fs.readFile(path.join(destination, 'package/package.json'), 'utf8'));
  assert(manifest.name === expectedName, `Packed manifest name mismatch for ${expectedName}.`);
  for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
    for (const dependency of Object.keys(manifest[field] ?? {}))
      assert(!privateNames.has(dependency), `${expectedName} exposes private runtime dependency ${dependency}.`);
  }
  /** 对实际 tarball 字节执行的类型发布契约分析。 */
  const typeAnalysis = await checkPackage(createPackageFromTarballData(await fs.readFile(tarball)));
  assert(typeAnalysis.types !== false, `${expectedName} tarball does not expose type declarations.`);
  if (typeAnalysis.types !== false) {
    /** 与主包 tsdown 配置一致，只忽略 ESM-only 包不承诺的 Node10/CJS 模式。 */
    const relevantProblems = typeAnalysis.problems.filter(problem => !('resolutionKind' in problem)
      || !esmOnlyIgnoredResolutions.has(problem.resolutionKind));
    assert(relevantProblems.length === 0, `${expectedName} tarball has type resolution problems: ${relevantProblems.map(problem => problem.kind).join(', ')}`);
  }
  /** 对解压后的精确发布文件执行 publint，不重新打包工作区源码。 */
  const packageRoot = path.join(destination, 'package');
  /** publint 对实际发布目录返回的结构化诊断。 */
  const lint = await publint({ pkgDir: packageRoot, pack: false, strict: true });
  assert(lint.messages.length === 0, `${expectedName} tarball failed publint: ${lint.messages.map(message => message.code).join(', ')}`);
  return manifest;
}

/**
 * 把 init 生成的 registry 版本依赖改为当前验证独占的本地 tarball。
 *
 * @param project 已生成脚手架工程根目录。
 * @param tarballs 公开包名到本地 tarball 的映射。
 */
async function pinScaffoldTarballs(project, tarballs) {
  /** init 生成且需要保持其他字段不变的 package manifest。 */
  const file = path.join(project, 'package.json');
  /** 脚手架清单中的可变开发依赖映射。 */
  const manifest = JSON.parse(await fs.readFile(file, 'utf8'));
  /** [name, tarball] 表示当前脚手架实际声明的公开包依赖。 */
  for (const [name, tarball] of tarballs) {
    if (manifest.devDependencies?.[name] !== undefined)
      manifest.devDependencies[name] = `file:${tarball}`;
  }
  await fs.writeFile(file, `${JSON.stringify(manifest, null, 2)}\n`);
}

/**
 * 只安装主包 tarball 并执行远程 MCP Migration，防止构建期验证例外退化为运行时依赖。
 *
 * @param mainTarball 当前验证生成的正式主包 tarball。
 * @param temporary 当前验证独占临时目录。
 */
async function verifyMainOnlyMigration(mainTarball, temporary) {
  /** 不安装任何可选 Extension 的独立消费者目录。 */
  const consumer = path.join(temporary, 'main-only-migration');
  /** 包含安全远程 MCP 的旧 Claude Plugin 来源。 */
  const legacy = path.join(consumer, 'legacy-plugin');
  await fs.mkdir(path.join(legacy, '.claude-plugin'), { recursive: true });
  await fs.writeFile(path.join(consumer, 'package.json'), `${JSON.stringify({
    name: 'acplugin-main-only-migration',
    version: '0.0.0',
    private: true,
    type: 'module',
    dependencies: { '@tokenroll/acplugin': `file:${mainTarball}` },
  }, null, 2)}\n`);
  await fs.writeFile(path.join(legacy, '.claude-plugin/plugin.json'), `${JSON.stringify({
    name: 'remote-mcp-migration',
    version: '1.0.0',
    description: 'Verify main-only packed Migration.',
  }, null, 2)}\n`);
  await fs.writeFile(path.join(legacy, '.mcp.json'), `${JSON.stringify({
    mcpServers: { docs: { type: 'http', url: 'https://mcp.example.com/mcp' } },
  }, null, 2)}\n`);

  await run('pnpm', ['install', '--ignore-workspace'], consumer);
  /** 真实安装 CLI 在没有 MCP Extension 包时返回的迁移报告。 */
  const migrated = await run('pnpm', [
    'exec', 'acplugin', 'migrate', 'legacy-plugin', 'migrated', '--json',
  ], consumer, { capture: true });
  /** 主包 lazy Migration chunk 的机器可读结果。 */
  const report = JSON.parse(migrated.stdout);
  assert(report.success === true, 'Main-only packed remote MCP Migration failed.');
  assert(report.items.some(item => item.kind === 'mcp' && item.outcome === 'migrated'), 'Main-only Migration did not preserve remote MCP.');
  await fs.access(path.join(consumer, 'migrated/src/mcp/docs/mcp.ts'));
  /** 主消费者中是否出现了不应由主包传递安装的可选 MCP Extension。 */
  let extensionInstalled = true;
  try {
    await fs.access(path.join(consumer, 'node_modules/@tokenroll/acplugin-extension-mcp'));
  } catch (error) {
    if (error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
      extensionInstalled = false;
    else
      throw error;
  }
  assert(!extensionInstalled, 'Main-only Migration unexpectedly installed the optional MCP Extension.');
}

/**
 * 在完全独立、忽略工作区解析的项目中安装并执行三个正式公开 tarball。
 *
 * @param tarballs 公开包名到本地 tarball 的映射。
 * @param temporary 当前验证独占临时目录。
 */
async function verifyConsumer(tarballs, temporary) {
  /** 模拟真实用户安装环境的干净工程目录。 */
  const consumer = path.join(temporary, 'consumer');
  await fs.mkdir(path.join(consumer, 'src/skills/hello'), { recursive: true });
  await fs.mkdir(path.join(consumer, 'src/hooks/policy'), { recursive: true });
  /** 只指向本次打包 tarball 的消费者依赖。 */
  const dependencies = Object.fromEntries(packages.map(item => [item.name, `file:${tarballs.get(item.name)}`]));
  await fs.writeFile(path.join(consumer, 'package.json'), `${JSON.stringify({
    name: 'acplugin-packed-consumer',
    version: '0.0.0',
    private: true,
    type: 'module',
    scripts: {
      typecheck: 'tsc --noEmit',
      validate: 'acplugin validate --json',
      build: 'acplugin build --json',
    },
    dependencies,
    devDependencies: {
      '@types/node': '^20.19.0',
      'typescript': '^7.0.2',
    },
  }, null, 2)}\n`);
  await fs.writeFile(path.join(consumer, 'tsconfig.json'), `${JSON.stringify({
    compilerOptions: {
      target: 'ES2022',
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      strict: true,
      noEmit: true,
      types: ['node'],
      skipLibCheck: true,
    },
    include: ['acplugin.config.ts', 'src/**/*.ts'],
  }, null, 2)}\n`);
  await fs.writeFile(path.join(consumer, 'acplugin.config.ts'), `import { defineConfig } from '@tokenroll/acplugin';
import hooks from '@tokenroll/acplugin-extension-hooks';
import mcp from '@tokenroll/acplugin-extension-mcp';

export default defineConfig({
  name: 'packed-consumer',
  version: '1.0.0',
  description: 'Clean tarball consumer.',
  extensions: [hooks(), mcp()],
});
`);
  await fs.writeFile(path.join(consumer, 'src/skills/hello/SKILL.md'), `---
description: Verify the packed consumer.
---
Validate that both default Platform packages can be built from installed tarballs.
`);
  await fs.writeFile(path.join(consumer, 'src/hooks/policy/hook.ts'), `import { defineHook } from '@tokenroll/acplugin-extension-hooks';

export default defineHook({
  event: 'PreToolUse',
  matcher: 'Bash',
  run(input) {
    return input.toolName === 'Bash' ? { decision: 'allow' } : undefined;
  },
});
`);

  await run('pnpm', ['install', '--ignore-workspace'], consumer);
  await run('pnpm', ['run', 'typecheck'], consumer);
  await run('node', ['--input-type=module', '--eval', 'import(\'@tokenroll/acplugin\').then(m => { if (typeof m.defineConfig !== \'function\') process.exit(1) })'], consumer);
  /** 安装产物执行 validate 的机器可读结果。 */
  const validate = await run('pnpm', ['exec', 'acplugin', 'validate', '--json'], consumer, { capture: true });
  assert(JSON.parse(validate.stdout).success === true, 'Packed consumer validation failed.');
  /** 安装产物执行默认双 Platform build 的机器可读结果。 */
  const build = await run('pnpm', ['exec', 'acplugin', 'build', '--json'], consumer, { capture: true });
  assert(JSON.parse(build.stdout).success === true, 'Packed consumer build failed.');
  await fs.access(path.join(consumer, 'dist/claude-code/plugin/.claude-plugin/plugin.json'));
  await fs.access(path.join(consumer, 'dist/codex/plugin/.codex-plugin/plugin.json'));
  await fs.access(path.join(consumer, 'dist/claude-code/plugin/hooks/policy/handler.mjs'));
  await fs.access(path.join(consumer, 'dist/codex/plugin/hooks/policy/handler.mjs'));

  /** 使用已安装正式 CLI 生成六 Platform、两空 Extension 的真实脚手架。 */
  const init = await run('pnpm', [
    'exec', 'acplugin', 'init', 'generated-plugin', '--yes', '--hooks', '--mcp',
    '--platform', 'claude-code', 'codex', 'cursor', 'antigravity', 'opencode', 'pi', '--json',
  ], consumer, { capture: true });
  /** init JSON stdout 的稳定机器可读结果。 */
  const initResult = JSON.parse(init.stdout);
  assert(initResult.success === true, 'Packed CLI init failed.');
  assert(initResult.platforms.length === 6, 'Packed CLI init did not preserve all selected Platforms.');
  /** 与调用工程隔离的新脚手架消费根。 */
  const generated = path.join(consumer, 'generated-plugin');
  await pinScaffoldTarballs(generated, tarballs);
  await run('pnpm', ['install', '--ignore-workspace'], generated);
  await run('pnpm', ['run', 'typecheck'], generated);
  /** 空 Hooks/MCP 不得妨碍六 Platform 严格校验。 */
  const scaffoldValidate = await run('pnpm', ['exec', 'acplugin', 'validate', '--json'], generated, { capture: true });
  assert(JSON.parse(scaffoldValidate.stdout).success === true, 'Generated six-Platform scaffold validation failed.');
  /** 六 Platform 脚手架的正式 build 结果。 */
  const scaffoldBuild = await run('pnpm', ['exec', 'acplugin', 'build', '--json'], generated, { capture: true });
  assert(JSON.parse(scaffoldBuild.stdout).success === true, 'Generated six-Platform scaffold build failed.');
  await fs.access(path.join(generated, 'dist/cursor/plugin/.cursor-plugin/plugin.json'));
  await fs.access(path.join(generated, 'dist/opencode/workspace/.opencode/skills/generated-plugin/SKILL.md'));
  await fs.access(path.join(generated, 'dist/pi/package/package.json'));
}

/**
 * 打包公开 Cohort、验证内容与版本关系，并执行干净消费者测试。
 */
async function main() {
  /** 无论成功失败默认都会删除的发布验证临时目录。 */
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'acplugin-release-verify-'));
  try {
    /** 存放三个新 tarball 的目录。 */
    const tarballDirectory = path.join(temporary, 'tarballs');
    /** 各包独立解压和清单检查的根目录。 */
    const extractRoot = path.join(temporary, 'extract');
    await fs.mkdir(tarballDirectory, { recursive: true });
    /** 公开包名到本次 tarball 的映射。 */
    const tarballs = new Map();
    /** 公开包名到 tarball 内实际清单的映射。 */
    const manifests = new Map();
    for (const item of packages) {
      /** 当前公开包由 pnpm pack 生成的 tarball 路径。 */
      const tarball = await tarballFor(tarballDirectory, item.name);
      tarballs.set(item.name, tarball);
      manifests.set(item.name, await inspectTarball(tarball, item.name, extractRoot));
    }
    /** 公开 Cohort 实际打包出的版本集合。 */
    const versions = new Set([...manifests.values()].map(manifest => manifest.version));
    assert(versions.size === 1, 'The public release cohort must use one version.');
    /** 三个公开包共同使用的唯一版本。 */
    const version = [...versions][0];
    assert(version === '1.0.0', `The release cohort must remain at 1.0.0 before the first manual publish, found ${version}.`);
    for (const extensionName of ['@tokenroll/acplugin-extension-hooks', '@tokenroll/acplugin-extension-mcp']) {
      /** 当前 Extension tarball 中声明的主包 Peer 版本范围。 */
      const peerRange = manifests.get(extensionName).peerDependencies?.['@tokenroll/acplugin'];
      assert(peerRange === `^${version}`, `${extensionName} must pack with @tokenroll/acplugin peer range ^${version}.`);
    }
    await verifyMainOnlyMigration(tarballs.get('@tokenroll/acplugin'), temporary);
    await verifyConsumer(tarballs, temporary);
    process.stdout.write(`Verified three @tokenroll/acplugin ${version} tarballs in a clean consumer.\n`);
  } finally {
    if (process.env.ACPLUGIN_KEEP_RELEASE_TEMP !== '1')
      await fs.rm(temporary, { recursive: true, force: true });
    else
      process.stderr.write(`Release verification files retained at ${temporary}\n`);
  }
}

await main();
