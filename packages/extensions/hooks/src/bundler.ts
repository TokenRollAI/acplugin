import { promises as fs } from 'node:fs';
import path from 'node:path';
import { build as rolldownBuild, type OutputChunk, type Plugin } from 'rolldown';
import type { ExtensionBuildContext } from '@tokenroll/acplugin';
import { EXTENSION_NAME } from './constants.js';
import type { DiscoveredHook, DiscoveredHooks } from './discovery.js';
import { createRunnerSource } from './runtime-source.js';

/** 单个 Hook 构建完成的可执行 Handler 与可选第三方许可材料。 */
export interface BundledHook {
  /** Hook 的稳定作者 ID。 */
  readonly id: string;
  /** Adapter 生成平台配置时读取的已验证定义。 */
  readonly definition: DiscoveredHook['definition'];
  /** Rolldown 生成的独立 Node 20 ESM Handler 路径。 */
  readonly handler: string;
  /** Bundle 包含第三方依赖时生成的合并许可文件路径。 */
  readonly licenses?: string;
}

/** build 阶段交给所有 Platform Adapter 的平台中立状态。 */
export interface BuiltHooks {
  /** 按 Hook ID 稳定排序且每项只 Bundle 一次的 Handler。 */
  readonly hooks: readonly BundledHook[];
}

/** Bundle 中一个第三方 npm 包的许可元数据与原始法律文本。 */
interface PackageLicense {
  /** npm 包名。 */
  readonly name: string;
  /** npm 包版本。 */
  readonly version: string;
  /** package.json 声明的 SPDX 表达式或 UNKNOWN。 */
  readonly license: string;
  /** 包根目录中发现的 LICENSE 或 NOTICE 文件。 */
  readonly notices: readonly { readonly name: string; readonly text: string }[];
}

/** Handler Bundle 内替换作者辅助 API 的私有虚拟模块 ID。 */
const AUTHOR_API_MODULE_ID = '\0acplugin-hook-author-api';

/**
 * 创建只保留 defineHook 运行时恒等语义的 Rolldown 虚拟模块。
 *
 * Hook 作者从 Extension 根入口导入 defineHook，但最终 Handler 不应携带构建器、
 * Rolldown 或 acplugin Core；品牌只服务 discover，Bundle 内定义已经通过验证。
 *
 * @returns 在解析作者 API 时替换为最小恒等函数的构建插件。
 */
function authorApiPlugin(): Plugin {
  return {
    name: 'acplugin-hook-author-api',
    /** 只接管规范 Extension 根入口，不改写用户的其他依赖。 */
    resolveId(source) {
      return source === EXTENSION_NAME ? AUTHOR_API_MODULE_ID : null;
    },
    /** 为虚拟入口提供无构建期依赖的 defineHook 实现。 */
    load(id) {
      if (id !== AUTHOR_API_MODULE_ID)
        return null;
      return 'export function defineHook(definition) { return definition; }';
    },
  };
}

/**
 * 从 Rolldown Module ID 向上查找所属 npm 包及其许可文件。
 *
 * @param moduleId Bundle 图中的原始 Module ID。
 * @returns 第三方 node_modules 文件对应的许可记录；工程源码返回 undefined。
 * @throws 第三方包缺少元数据或法律文本时阻止生成不完整 Bundle。
 */
async function packageLicenseForModule(moduleId: string): Promise<PackageLicense | undefined> {
  /** 移除 Rolldown 查询参数和虚拟模块前缀后的文件路径。 */
  const normalized = moduleId.replace(/\?.*$/u, '').replace(/^\0/u, '');
  if (!normalized.includes(`${path.sep}node_modules${path.sep}`))
    return undefined;
  /** 从模块文件开始向上查找 package.json 的当前目录。 */
  let directory = path.dirname(normalized);
  /** 终止向上遍历的文件系统根目录。 */
  const root = path.parse(directory).root;
  while (directory !== root) {
    try {
      /** 当前候选目录中的包清单。 */
      const manifest = JSON.parse(await fs.readFile(path.join(directory, 'package.json'), 'utf8')) as {
        readonly name?: unknown;
        readonly version?: unknown;
        readonly license?: unknown;
      };
      if (typeof manifest.name === 'string' && typeof manifest.version === 'string') {
        /** 包根目录的一级文件，用于发现法律文本。 */
        const entries = await fs.readdir(directory, { withFileTypes: true });
        /** 按稳定顺序保留的 LICENSE 与 NOTICE 文件名。 */
        const noticeFiles = entries
          .filter(entry => entry.isFile() && /^(?:licen[cs]e|notice)(?:\..*)?$/iu.test(entry.name))
          .map(entry => entry.name)
          .sort((left, right) => left.localeCompare(right, 'en'));
        if (noticeFiles.length === 0)
          throw new Error(`Bundled dependency ${manifest.name}@${manifest.version} has no license or notice file.`);
        return {
          name: manifest.name,
          version: manifest.version,
          license: typeof manifest.license === 'string' ? manifest.license : 'UNKNOWN',
          notices: await Promise.all(noticeFiles.map(async (name) => {
            /** 当前第三方法律文件的完整文本。 */
            const text = (await fs.readFile(path.join(directory, name), 'utf8')).trimEnd();
            return Object.freeze({ name, text });
          })),
        };
      }
    } catch /** error 保存当前操作捕获的异常，供本阶段转换或恢复。 */ (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        throw error;
    }
    directory = path.dirname(directory);
  }
  throw new Error(`Cannot resolve package metadata for bundled module ${path.basename(normalized)}.`);
}

/**
 * 汇总 Bundle 实际包含的第三方包许可，并写入稳定文本文件。
 *
 * @param chunk 唯一的 Rolldown 输出 Chunk。
 * @param directory Handler Bundle 所在目录。
 * @returns 存在第三方依赖时返回许可文件路径，否则返回 undefined。
 */
async function writeThirdPartyLicenses(chunk: OutputChunk, directory: string): Promise<string | undefined> {
  /** 按包名和版本去重的许可记录。 */
  const records = new Map<string, PackageLicense>();
  /** moduleId 表示当前 Bundle Module，用于追溯第三方许可。 */
  for (const moduleId of Object.keys(chunk.modules).sort((left, right) => left.localeCompare(right, 'en'))) {
    /** 当前 Bundle Module 所属的可选第三方包许可。 */
    const record = await packageLicenseForModule(moduleId);
    if (record !== undefined)
      records.set(`${record.name}@${record.version}`, record);
  }
  if (records.size === 0)
    return undefined;
  /** 按确定顺序拼接的许可文件段落。 */
  const sections = ['THIRD-PARTY LICENSES'];
  for (const [id, record] of [...records].sort(([left], [right]) => left.localeCompare(right, 'en'))) {
    sections.push(`## ${id}\nSPDX: ${record.license}`);
    /** notice 表示当前包的一个 LICENSE 或 NOTICE 文件。 */
    for (const notice of record.notices)
      sections.push(`### ${notice.name}\n${notice.text}`);
  }
  /** 与 Handler 一同发布的第三方许可文件路径。 */
  const destination = path.join(directory, 'THIRD_PARTY_LICENSES.txt');
  await fs.writeFile(destination, `${sections.join('\n\n')}\n`);
  return destination;
}

/**
 * 判断 Bundle 模块图是否包含 Node 原生扩展。
 *
 * @param moduleId Rolldown 输出记录的 Module ID。
 * @returns 文件扩展名是 `.node` 时返回 true。
 */
function isNativeAddon(moduleId: string): boolean {
  /** 去掉查询参数后的真实模块路径。 */
  const normalized = moduleId.replace(/\?.*$/u, '');
  return path.extname(normalized) === '.node';
}

/**
 * 把 Rolldown 实际解析的作者模块图登记给 Core，排除 Extension 自己生成的临时入口。
 *
 * @param context 当前 Extension build 上下文。
 * @param moduleIds 输出 Chunk 中的全部模块 ID。
 */
function registerBundleWatchFiles(context: ExtensionBuildContext, moduleIds: readonly string[]): void {
  for (const moduleId of moduleIds) {
    /** 查询参数不属于文件名，虚拟模块与相对 ID 也不能交给文件监听器。 */
    const file = moduleId.replace(/\?.*$/u, '');
    if (!path.isAbsolute(file))
      continue;
    /** runner.mjs 位于每轮都会删除的 workDir，监听它会制造无效重建。 */
    const relative = path.relative(context.workDir, file);
    if (relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)))
      continue;
    context.addWatchFile(file);
  }
}

/**
 * 把单个用户 Hook 与框架运行器构建为独立、平台中立的 ESM Handler。
 *
 * @param hook 待构建的 Hook 描述。
 * @param workDir Extension 在本次构建中的隔离工作目录。
 * @returns Adapter 可以直接贡献的 Handler 与可选许可文件。
 */
async function bundleHook(hook: DiscoveredHook, context: ExtensionBuildContext): Promise<BundledHook> {
  /** 当前 Hook 独占的 Bundle 工作目录。 */
  const directory = path.join(context.workDir, hook.id);
  await fs.mkdir(directory, { recursive: true });
  /** 动态生成且导入用户 hook.ts 的 Rolldown 入口。 */
  const runner = path.join(directory, 'runner.mjs');
  await fs.writeFile(runner, createRunnerSource(hook, directory));
  /** 保留 Node 内置模块为 external 的内存构建结果。 */
  const output = await rolldownBuild({
    input: runner,
    platform: 'node',
    transform: { target: 'node20' },
    plugins: [authorApiPlugin()],
    external: [/^node:/u],
    write: false,
    output: {
      format: 'esm',
      sourcemap: false,
      codeSplitting: false,
      comments: { legal: true },
    },
  });
  /** 构建产生的 JavaScript Chunk；协议要求严格只有一个。 */
  const chunks = output.output.filter((item): item is OutputChunk => item.type === 'chunk');
  if (chunks.length !== 1 || output.output.some(item => item.type === 'asset'))
    throw new Error(`Hook "${hook.id}" must bundle to one JavaScript chunk and no assets.`);
  /** 唯一输出 Chunk，用于原生依赖检查、写入和许可收集。 */
  const chunk = chunks[0]!;
  if (Object.keys(chunk.modules).some(isNativeAddon))
    throw new Error(`Hook "${hook.id}" includes an unsupported native addon.`);
  // dev 必须跟随 Rolldown 的真实解析结果，而不是只监听 hook.ts 描述入口。
  registerBundleWatchFiles(context, Object.keys(chunk.modules));
  /** 最终贡献给 Plugin 的独立 ESM Handler。 */
  const handler = path.join(directory, 'handler.mjs');
  await fs.writeFile(handler, chunk.code);
  /** Bundle 包含第三方依赖时生成的许可汇总。 */
  const licenses = await writeThirdPartyLicenses(chunk, directory);
  return Object.freeze({
    id: hook.id,
    definition: hook.definition,
    handler,
    ...(licenses === undefined ? {} : { licenses }),
  });
}

/**
 * 为全部已验证 Hook 各生成一次平台中立 Handler。
 *
 * @param context Core 提供的 Extension 隔离工作目录。
 * @param discovered 已通过 validate 阶段的 Hooks 状态。
 * @returns 可由多个 Platform Adapter 复用的稳定 Built State。
 */
export async function buildHooks(
  context: ExtensionBuildContext,
  discovered: Readonly<DiscoveredHooks>,
): Promise<BuiltHooks> {
  /** 按发现顺序构建的 Handler 列表。 */
  const hooks: BundledHook[] = [];
  for (const hook of discovered.hooks)
    hooks.push(await bundleHook(hook, context));
  return Object.freeze({ hooks: Object.freeze(hooks) });
}
