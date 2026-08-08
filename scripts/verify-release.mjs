import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { builtinModules } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, URL } from 'node:url';
import { checkPackage, createPackageFromTarballData } from '@arethetypeswrong/core';
import { init as initializeModuleLexer, parse as parseModule } from 'es-module-lexer';
import { publint } from 'publint';

/** 当前 monorepo 根目录。 */
const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
/** 同一 revision 中独立版本化并共同验证的全部公开包。 */
const packages = [
  { name: '@tokenroll/acplugin' },
  { name: '@tokenroll/acplugin-platform-claude-code' },
  { name: '@tokenroll/acplugin-platform-codex' },
  { name: '@tokenroll/acplugin-platform-cursor' },
  { name: '@tokenroll/acplugin-platform-antigravity' },
  { name: '@tokenroll/acplugin-platform-opencode' },
  { name: '@tokenroll/acplugin-platform-pi' },
  { name: '@tokenroll/acplugin-extension-hooks' },
  { name: '@tokenroll/acplugin-extension-mcp' },
];
/** 主包之外必须通过 Peer Dependency 连接主包的官方生态包名。 */
const integrationNames = new Set(packages.slice(1).map(item => item.name));
/** 发布 tarball 运行时依赖中绝不能出现的私有工作区包名。 */
const privateNames = new Set([
  '@acplugin/core',
  '@acplugin/test',
]);
/** ESM-only 正式包按 ATTW esm-only Profile 有意不提供的旧/CJS 解析模式。 */
const esmOnlyIgnoredResolutions = new Set(['node10', 'node16-cjs']);
/** Node 同时允许 `node:fs` 和 legacy `fs` 形式的内建模块边。 */
const nodeBuiltinSpecifiers = new Set(builtinModules.flatMap(name => [name, `node:${name.replace(/^node:/u, '')}`]));

/**
 * 解析可选的 tarball 保留目录，并拒绝含糊或可能覆盖已有文件的调用。
 *
 * @param args Node 入口之后的命令行参数。
 * @returns 显式目录的绝对路径；本地默认临时验证时返回 undefined。
 */
async function retainedTarballDirectory(args) {
  /** pnpm 10 会把 `pnpm run <script> -- ...` 中的分隔符原样传给脚本。 */
  const normalized = args[0] === '--' ? args.slice(1) : args;
  if (normalized.length === 0)
    return undefined;
  if (normalized.length !== 2 || normalized[0] !== '--tarball-dir'
    || typeof normalized[1] !== 'string' || normalized[1].includes('\0')) {
    throw new Error('Usage: pnpm run release:verify -- --tarball-dir <empty-directory>');
  }
  /** 调用方要求保留精确已验证 tarball 的绝对目录。 */
  const directory = path.resolve(process.cwd(), normalized[1]);
  /** 已有目录内容；不存在时按空目录处理。 */
  let entries = [];
  try {
    entries = await fs.readdir(directory);
  } catch (error) {
    if (error === null || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT')
      throw error;
  }
  assert(entries.length === 0, `Tarball output directory must be empty: ${directory}`);
  return directory;
}

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
 * 递归列出一个目录中的全部 ESM 运行时文件。
 *
 * @param directory 当前遍历目录。
 * @param packageRoot 解压后 package 根，用于生成稳定相对路径。
 * @returns 按 code-unit 排序的 package 相对 `.mjs` 路径。
 */
async function esmFiles(directory, packageRoot) {
  /** 当前目录按 code-unit 排序后的文件系统项。 */
  const entries = (await fs.readdir(directory, { withFileTypes: true }))
    .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
  /** 当前子树累计的 ESM 文件。 */
  const files = [];
  for (const entry of entries) {
    /** 当前目录项的绝对路径。 */
    const target = path.join(directory, entry.name);
    if (entry.isDirectory())
      files.push(...await esmFiles(target, packageRoot));
    else if (entry.isFile() && entry.name.endsWith('.mjs'))
      files.push(path.relative(packageRoot, target).split(path.sep).join('/'));
  }
  return files;
}

/**
 * 从 exports/bin 的嵌套条件中提取所有 ESM 运行时入口。
 *
 * @param value 当前 manifest 字段或条件分支。
 * @param entries 累计的 package 相对入口。
 */
function collectRuntimeEntries(value, entries) {
  if (typeof value === 'string') {
    if (value.endsWith('.mjs'))
      entries.add(value.replace(/^\.\//u, ''));
    return;
  }
  if (value === null || typeof value !== 'object')
    return;
  for (const child of Object.values(value))
    collectRuntimeEntries(child, entries);
}

/**
 * 把裸 ESM specifier 收敛为 manifest 使用的依赖包名。
 *
 * @param specifier 模块源码中的非相对导入。
 * @returns scope/name 或首个路径段。
 */
function dependencyName(specifier) {
  if (specifier.startsWith('@'))
    return specifier.split('/').slice(0, 2).join('/');
  return specifier.split('/')[0];
}

/**
 * 从一个已解压主包的真实 ESM 语法建立静态/动态模块图并验证可选 MCP 边界。
 *
 * @param packageRoot 主包 tarball 的解压 package 根。
 * @param manifest tarball 内真实发布清单。
 */
async function verifyMainModuleGraph(packageRoot, manifest) {
  await initializeModuleLexer;
  /** tarball 中全部可执行 ESM 模块。 */
  const files = await esmFiles(path.join(packageRoot, 'dist'), packageRoot);
  /** 模块到其静态、动态本地边和外部边的完整解析结果。 */
  const graph = new Map();
  for (const file of files) {
    /** 当前构建模块的真实源码。 */
    const source = await fs.readFile(path.join(packageRoot, file), 'utf8');
    /** ESM lexer 返回的全部 import/export 边。 */
    const [imports] = parseModule(source, file);
    /** 当前模块可由字面量精确解析的静态本地边。 */
    const staticLocal = [];
    /** 当前模块可由字面量精确解析的动态本地边。 */
    const dynamicLocal = [];
    /** 当前模块声明的裸外部依赖边。 */
    const external = [];
    for (const imported of imports) {
      if (imported.n === undefined)
        continue;
      /** lexer 已解码的模块 specifier。 */
      const specifier = imported.n;
      if (specifier.startsWith('./') || specifier.startsWith('../')) {
        /** 相对于导入方解析后的 package 内目标。 */
        const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier));
        assert(!target.startsWith('../') && target !== '..', `Module ${file} imports outside the packed package: ${specifier}`);
        (imported.d === -1 ? staticLocal : dynamicLocal).push(target);
      } else {
        external.push(specifier);
      }
    }
    graph.set(file, Object.freeze({ staticLocal, dynamicLocal, external }));
  }

  /** exports 与 bin 共同定义的全部公开 eager 运行时入口。 */
  const entries = new Set();
  collectRuntimeEntries(manifest.exports, entries);
  collectRuntimeEntries(manifest.bin, entries);
  assert(entries.size > 0, 'Main package manifest exposes no ESM runtime entry.');
  /** 从所有公开入口只沿静态边可达的 eager 图。 */
  const eager = new Set();
  /** 尚未展开静态依赖边的入口或 chunk。 */
  const pending = [...entries];
  while (pending.length > 0) {
    /** 当前待遍历的 package 相对模块。 */
    const current = pending.pop();
    if (eager.has(current))
      continue;
    /** 每个 manifest 或静态图目标都必须真实随 tarball 发布。 */
    const edges = graph.get(current);
    assert(edges !== undefined, `Packed runtime module is missing: ${current}`);
    eager.add(current);
    for (const target of edges.staticLocal)
      pending.push(target);
  }

  /** CLI 通过字面量动态 import 暴露的 Migration lazy chunk。 */
  const cliEntry = typeof manifest.bin === 'string'
    ? manifest.bin.replace(/^\.\//u, '')
    : manifest.bin?.acplugin?.replace(/^\.\//u, '');
  assert(typeof cliEntry === 'string', 'Main package manifest is missing the acplugin CLI entry.');
  /** CLI 的动态本地边应保留至少一个不属于 eager 图的独立 chunk。 */
  const lazyTargets = graph.get(cliEntry)?.dynamicLocal ?? [];
  assert(lazyTargets.length > 0, 'Main CLI has no statically identifiable lazy Migration edge.');
  for (const target of lazyTargets) {
    assert(graph.has(target), `Main CLI lazy chunk is missing from the tarball: ${target}`);
    assert(!eager.has(target), `Main CLI lazy chunk became statically reachable: ${target}`);
  }

  /** 公开包清单允许存在的全部运行时外部依赖。 */
  const declared = new Set([
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.peerDependencies ?? {}),
    ...Object.keys(manifest.optionalDependencies ?? {}),
  ]);
  for (const integration of integrationNames)
    assert(!declared.has(integration), `Main package manifest must not depend on official integration ${integration}.`);
  for (const [file, edges] of graph) {
    for (const specifier of edges.external) {
      if (nodeBuiltinSpecifiers.has(specifier))
        continue;
      /** 外部子路径按其所属 package 与 manifest runtime edge 对齐。 */
      const dependency = dependencyName(specifier);
      assert(declared.has(dependency), `Packed module ${file} imports undeclared runtime dependency ${dependency}.`);
      assert(!integrationNames.has(dependency), `Packed module ${file} externalizes official integration ${dependency}.`);
    }
  }
}

/**
 * 验证独立 Platform/Extension 运行时只通过公开主包 Peer 使用框架品牌。
 *
 * @param packageRoot 生态包 tarball 的解压 package 根。
 * @param manifest tarball 内真实发布清单。
 */
async function verifyIntegrationModuleGraph(packageRoot, manifest) {
  /** 当前生态包中全部 ESM 运行时模块。 */
  const files = await esmFiles(path.join(packageRoot, 'dist'), packageRoot);
  /** 全部运行时模块源码，用于检查公开 peer 边和私有 namespace 泄漏。 */
  const source = (await Promise.all(files.map(file => fs.readFile(path.join(packageRoot, file), 'utf8')))).join('\n');
  assert(manifest.peerDependencies?.['@tokenroll/acplugin'] !== undefined, `${manifest.name} must peer-depend on @tokenroll/acplugin.`);
  assert(source.includes('from "@tokenroll/acplugin"'), `${manifest.name} runtime must import the public @tokenroll/acplugin SDK.`);
  assert(!source.includes('@acplugin/'), `${manifest.name} runtime leaks a private @acplugin/* import.`);
  for (const integration of integrationNames) {
    if (integration !== manifest.name)
      assert(!source.includes(`from "${integration}"`), `${manifest.name} runtime imports another official integration ${integration}.`);
  }
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
      assert(!privateNames.has(dependency) && !dependency.startsWith('@acplugin/'), `${expectedName} exposes private runtime dependency ${dependency}.`);
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
  if (expectedName === '@tokenroll/acplugin')
    await verifyMainModuleGraph(packageRoot, manifest);
  else
    await verifyIntegrationModuleGraph(packageRoot, manifest);
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
  /** 迁移结果必须声明独立 Platform package，而不是依赖主包历史 re-export。 */
  const generatedManifest = JSON.parse(await fs.readFile(path.join(consumer, 'migrated/package.json'), 'utf8'));
  assert(generatedManifest.devDependencies?.['@tokenroll/acplugin-platform-claude-code']?.startsWith('^') === true, 'Migration did not declare the independent Claude Code Platform package.');
  /** 迁移结果的配置源码必须从独立包加载工厂。 */
  const generatedConfig = await fs.readFile(path.join(consumer, 'migrated/acplugin.config.ts'), 'utf8');
  assert(generatedConfig.includes('from \'@tokenroll/acplugin-platform-claude-code\''), 'Migration config still relies on a main-package Platform export.');
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
 * 在完全独立、忽略工作区解析的项目中安装并执行九个正式公开 tarball。
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
import { definePlatform } from '@tokenroll/acplugin';
import claudeCode from '@tokenroll/acplugin-platform-claude-code';
import codex from '@tokenroll/acplugin-platform-codex';
import hooks from '@tokenroll/acplugin-extension-hooks';
import mcp from '@tokenroll/acplugin-extension-mcp';

const external = definePlatform({
  id: 'external-fixture',
  apiVersion: '1',
  deliveryType: 'plugin',
  prepare: () => ({ documents: [], artifacts: [] }),
  generateBundle: () => ({ id: 'plugin', role: 'primary', type: 'plugin', artifacts: [] }),
  validateBundle() {},
});

export default defineConfig({
  name: 'packed-consumer',
  version: '1.0.0',
  description: 'Clean tarball consumer.',
  platforms: [claudeCode(), codex(), external],
  extensions: [hooks(), mcp()],
  build: { strict: false },
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
  /** packed 主包同时接受官方 peer package 与第三方形态 Platform 的验证报告。 */
  const validateReport = JSON.parse(validate.stdout);
  assert(validateReport.success === true, 'Packed consumer validation failed.');
  assert(validateReport.platforms.includes('external-fixture'), 'Packed consumer rejected the external Platform shape.');
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
 * 打包九个独立公开包、验证 Peer 关系，并执行干净消费者测试。
 */
async function main() {
  /** CI 可显式保留 tarball；本地无参数调用仍完全使用临时目录。 */
  const retained = await retainedTarballDirectory(process.argv.slice(2));
  /** 无论成功失败默认都会删除的发布验证临时目录。 */
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'acplugin-release-verify-'));
  try {
    /** 存放九个新 tarball 的显式保留目录或临时目录。 */
    const tarballDirectory = retained ?? path.join(temporary, 'tarballs');
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
    /** 主包当前独立版本决定 workspace:^ 在所有生态 tarball 中的改写结果。 */
    const mainVersion = manifests.get('@tokenroll/acplugin').version;
    for (const integrationName of integrationNames) {
      /** 当前 Platform/Extension tarball 中声明的主包 Peer 版本范围。 */
      const peerRange = manifests.get(integrationName).peerDependencies?.['@tokenroll/acplugin'];
      assert(peerRange === `^${mainVersion}`, `${integrationName} must pack with @tokenroll/acplugin peer range ^${mainVersion}.`);
    }
    await verifyMainOnlyMigration(tarballs.get('@tokenroll/acplugin'), temporary);
    await verifyConsumer(tarballs, temporary);
    /** 输出独立包版本，避免把同 revision 验证误表述为 fixed cohort。 */
    const versions = packages.map(item => `${item.name}@${manifests.get(item.name).version}`).join(', ');
    process.stdout.write(`Verified nine independent public tarballs in a clean consumer: ${versions}.\n`);
    if (retained)
      process.stdout.write(`Verified tarballs retained at ${retained}\n`);
  } finally {
    if (process.env.ACPLUGIN_KEEP_RELEASE_TEMP !== '1')
      await fs.rm(temporary, { recursive: true, force: true });
    else
      process.stderr.write(`Release verification files retained at ${temporary}\n`);
  }
}

await main();
