import { promises as fs } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ModuleService, SourceFileRef } from '../kernel-types.js';
import { safeRelativePath, validatePhysicalEntry } from './path-policy.js';
import { SourceRegistry } from './source-registry.js';
import { WatchRegistry, type WatchObservation } from './watch-registry.js';
import { WorkDirectoryRegistry } from './work-directories.js';
import { loadManagedEngine, type EngineInputOptions, type EngineOutputOptions, type ManagedEngine } from '../compiler/engine-loader.js';
import { packageScope, type ManagedPackageScope } from '../compiler/managed-boundary.js';
import { normalizeNodeBuiltin, portableNodePolicyPlugin } from '../compiler/portable-policy.js';

/** Module Host operation 使用的稳定 ID。 */
const MODULE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** 路径语义之外的 bare/package-import specifier。 */
function isPackageSpecifier(source: string): boolean {
  return source.startsWith('#') || (!source.startsWith('.')
    && !source.startsWith('/')
    && !source.startsWith('file:')
    && !source.startsWith('\0'));
}

/** Core Module Host 使用的 owner-scoped resolver 状态。 */
interface ModuleResolutionState {
  readonly projectRoot: string;
  readonly sourceRoot: string;
  readonly packages: Map<string, ManagedPackageScope>;
  readonly packageEntries: Map<string, ManagedPackageScope>;
  readonly resolutionManifests: Set<string>;
}

/**
 * 查找 package imports 解析所依赖的最近 package.json。
 *
 * @param state 当前 Module operation 边界。
 * @param importer 发起 `#` import 的模块。
 */
async function observeNearestManifest(state: ModuleResolutionState, importer: string | undefined): Promise<void> {
  if (importer === undefined)
    return;
  /** query 不参与物理祖先查找。 */
  let directory = path.dirname(importer.replace(/\?.*$/u, ''));
  while (true) {
    if (!path.isAbsolute(directory) || path.relative(state.projectRoot, directory).startsWith(`..${path.sep}`))
      return;
    /** `#imports` 的语义由最近 package scope manifest 决定。 */
    const manifest = path.join(directory, 'package.json');
    /** 当前候选 manifest 的普通文件状态。 */
    const stat = await fs.lstat(manifest).catch(() => undefined);
    if (stat?.isFile() === true && !stat.isSymbolicLink()) {
      state.resolutionManifests.add(await fs.realpath(manifest));
      return;
    }
    if (path.resolve(directory) === path.resolve(state.projectRoot))
      return;
    /** 下一层 package scope 候选目录。 */
    const parent = path.dirname(directory);
    if (parent === directory)
      return;
    directory = parent;
  }
}

/**
 * 建立本地源码闭包与外部 package identity 的 Module Host resolver。
 *
 * @param state 当前 load operation 的授权 source/package 集。
 * @returns 只 externalize 已证明 package entry 的 Core Plugin。
 */
function moduleResolutionPlugin(state: ModuleResolutionState): import('../kernel-types.js').ManagedRolldownPlugin {
  return Object.freeze({
    name: 'acplugin-module-resolution',
    resolveId: {
      order: 'pre' as const,
      /** 先让同一 Rolldown resolver 得到精确 exports/imports 结果，再建立边界。 */
      async handler(source, importer, options) {
        /** Node builtin 始终使用唯一 node: external identity。 */
        const builtin = normalizeNodeBuiltin(source);
        if (builtin !== undefined)
          return { id: builtin, external: true };
        /** NUL virtual helpers 由其他 Core Plugin 处理。 */
        if (source.startsWith('\0'))
          return null;
        if (source.startsWith('#'))
          await observeNearestManifest(state, importer);
        /** skipSelf 保留 Rolldown Node-compatible exports/imports 解析。 */
        const resolved = await this.resolve(source, importer, { ...options, skipSelf: true });
        if (resolved === null)
          throw new Error('Module Host could not resolve an imported module.');
        if (resolved.external)
          throw new Error('Module Host received an unverified external import.');
        /** resolver 结果必须是普通物理文件。 */
        const file = resolved.id.replace(/\?.*$/u, '');
        if (!path.isAbsolute(file))
          throw new Error('Module Host resolved an unsafe non-file module.');
        /** resolver 返回模块的真实物理路径。 */
        const real = await fs.realpath(file);
        /** 裸 package import 即使物理上位于 projectRoot/node_modules，也必须保持 package identity。 */
        if (isPackageSpecifier(source) && !source.startsWith('#')) {
          /** dependency 保存真实 Package root、name 与 version identity。 */
          const dependency = await packageScope(real);
          if (dependency === undefined)
            throw new Error('Module Host package import has no valid package identity.');
          state.packages.set(dependency.root, dependency);
          state.packageEntries.set(real, dependency);
          return { id: pathToFileURL(real).href, external: true };
        }
        /** local relative/# graph 必须留在入口被授予的 Source root。 */
        const relative = path.relative(state.sourceRoot, real);
        if (relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`))) {
          /** 每个实际读取的模块逐项拒绝 symlink/special/escape，不扫描无关工程目录。 */
          await validatePhysicalEntry(state.sourceRoot, file, 'file');
          return { ...resolved, id: real };
        }
        /** `#imports` 只有显式解析到外部 package 时才可建立 package capability。 */
        if (!source.startsWith('#'))
          throw new Error('Module Host local import escaped its authorized source root.');
        /** bare/# 解析到的最近 package identity。 */
        const dependency = await packageScope(real);
        if (dependency === undefined)
          throw new Error('Module Host package import has no valid package identity.');
        state.packages.set(dependency.root, dependency);
        state.packageEntries.set(real, dependency);
        return { id: pathToFileURL(real).href, external: true };
      },
    },
  });
}

/** Module Host 初始化依赖。 */
export interface ModuleHostOptions {
  readonly projectRoot: string;
  readonly sources: SourceRegistry;
  readonly workDirectories: WorkDirectoryRegistry;
  readonly watch: WatchRegistry;
}

/** Core 唯一、按 owner 签发可信 TS/JS loader 的 Module Host。 */
export class ModuleHost {
  /** 工程解析根。 */
  readonly #projectRoot: string;
  /** 系统祖先 symlink 解析后的工程物理根。 */
  readonly #projectRealRoot: Promise<string>;
  /** SourceRef 运行时授权注册表。 */
  readonly #sources: SourceRegistry;
  /** 生成并执行临时 ESM 的 owner workDir。 */
  readonly #workDirectories: WorkDirectoryRegistry;
  /** BuildSession 唯一 Watch Registry。 */
  readonly #watch: WatchRegistry;
  /** 与 Compiler Host 相同的唯一 Rolldown driver。 */
  readonly #engine: Promise<ManagedEngine>;
  /** owner 内已消费的 module operation ID。 */
  readonly #operations = new Map<string, Set<string>>();

  /**
   * 创建 BuildSession 唯一 Module Host。
   *
   * @param options 当前 Session registries。
   */
  constructor(options: ModuleHostOptions) {
    this.#projectRoot = path.resolve(options.projectRoot);
    this.#projectRealRoot = fs.realpath(this.#projectRoot);
    this.#sources = options.sources;
    this.#workDirectories = options.workDirectories;
    this.#watch = options.watch;
    this.#engine = loadManagedEngine();
  }

  /**
   * 为 Framework/Integration owner 签发闭包绑定 ModuleService。
   *
   * @param owner 当前 Kernel owner。
   * @returns 不接受调用方自报 owner/path 的 loader。
   */
  service(owner: string): ModuleService {
    if (typeof owner !== 'string' || owner.length === 0)
      throw new Error('Module owner must be a non-empty string.');
    return Object.freeze({
      /** request 只能包含 stable ID 和 SourceFileRef。 */
      loadDefault: <T>(request: { readonly id: string; readonly entry: SourceFileRef }) => this.#loadDefault<T>(owner, request),
    });
  }

  /**
   * Bundle、fresh evaluate 并返回一个可信模块的 default export。
   *
   * @param owner 当前 service owner。
   * @param request stable ID 与入口 ref。
   * @returns 原始 default export；schema normalization 由消费者负责。
   */
  async #loadDefault<T>(
    owner: string,
    request: { readonly id: string; readonly entry: SourceFileRef },
  ): Promise<T> {
    if (typeof request !== 'object' || request === null
      || Object.keys(request).some(field => field !== 'id' && field !== 'entry')) {
      throw new Error('Module load request must contain only id and entry.');
    }
    if (!MODULE_ID.test(request.id))
      throw new Error('Module load id must use lowercase kebab-case.');
    /** operation ID 在执行前消费，防止覆盖同一 work output。 */
    const operations = this.#operations.get(owner) ?? new Set<string>();
    if (operations.has(request.id))
      throw new Error(`Module load id "${request.id}" was already used by this owner.`);
    operations.add(request.id);
    this.#operations.set(owner, operations);
    /** 入口指纹必须在 Rolldown 读取前复核。 */
    const record = await this.#sources.validatedFile(owner, request.entry);
    /** Rolldown 入口真实物理路径。 */
    const entry = await fs.realpath(record.physicalPath);
    /** local graph 不能逃逸的授权 source root。 */
    const sourceRoot = await fs.realpath(record.root);
    /** 当前 operation 经 bare/# import 证明的 package 集。 */
    const packages = new Map<string, ManagedPackageScope>();
    /** externalized package entry 到 package identity 的精确证明。 */
    const packageEntries = new Map<string, ManagedPackageScope>();
    /** `package.json#imports` 解析所读取的最近 manifest。 */
    const resolutionManifests = new Set<string>();
    /** 当前 operation 完整的 resolver observation state。 */
    const resolutionState: ModuleResolutionState = {
      projectRoot: await this.#projectRealRoot,
      sourceRoot,
      packages,
      packageEntries,
      resolutionManifests,
    };
    /** entry 最近 package scope 影响 imports/type 语义，始终进入 watch。 */
    await observeNearestManifest(resolutionState, entry);
    /** 与 Compiler Host 完全相同的 Rolldown driver。 */
    const engine = await this.#engine;
    /** 固定 Module Host 入口/tsconfig/log/plugin 边界。 */
    const inputOptions: EngineInputOptions = {
      input: { module: entry },
      cwd: this.#projectRoot,
      platform: 'node',
      tsconfig: false,
      logLevel: 'silent',
      watch: false,
      /** builtin 由 resolver 规范成 node: external，其余 import 必须显式解析。 */
      external: id => normalizeNodeBuiltin(id) !== undefined,
      plugins: [
        moduleResolutionPlugin(resolutionState),
        portableNodePolicyPlugin(engine),
      ],
    };
    /** create 成功后任何 generate/import 错误都必须 close bundle。 */
    let bundle: Awaited<ReturnType<ManagedEngine['create']>> | undefined;
    try {
      bundle = await engine.create(inputOptions);
      /** Module Host 的固定单 ESM output options。 */
      const outputOptions: EngineOutputOptions = {
        format: 'es',
        entryFileNames: 'module.mjs',
        codeSplitting: false,
        sourcemap: false,
        /** 消除 Rolldown 1.2.2 绝对 module region，不压缩表达式或名称。 */
        minify: { compress: false, mangle: false },
      };
      /** generate-only 的单文件内存输出。 */
      const output = await bundle.generate(outputOptions);
      if (output.output.length !== 1 || output.output[0]?.type !== 'chunk'
        || output.output[0].fileName !== 'module.mjs' || !output.output[0].isEntry)
        throw new Error('Module Host must produce exactly one ESM entry chunk.');
      /** 输出只写当前 owner workDir，不使用 dist 或系统任意临时路径。 */
      const workDirectory = await this.#workDirectories.directory(owner);
      /** 当前 load operation 的固定 workDir-relative 文件。 */
      const relative = safeRelativePath(`modules/${request.id}/module.mjs`);
      /** 只在 Host 内部可见的执行物理路径。 */
      const physical = this.#workDirectories.resolve(owner, workDirectory, relative);
      await fs.mkdir(path.dirname(physical), { recursive: true, mode: 0o700 });
      await fs.writeFile(physical, output.output[0].code, { flag: 'wx', mode: 0o600 });
      /** local graph、package entries/manifests 形成一个原子 watch operation。 */
      const observations = new Map<string, WatchObservation>();
      for (const file of await bundle.watchFiles) {
        /** 当前 Rolldown module/watch input 的真实路径。 */
        const real = await fs.realpath(file);
        /** 外部 watch input 所属的 package identity。 */
        const dependency = [...packages.values()].find(candidate => real === candidate.root || real.startsWith(`${candidate.root}${path.sep}`));
        observations.set(real, Object.freeze({
          path: real,
          type: 'file' as const,
          ...(dependency === undefined ? {} : { identity: `package:${dependency.name}@${dependency.version}/${path.relative(dependency.root, real).split(path.sep).join('/')}` }),
        }));
      }
      for (const dependency of packages.values()) {
        /** package exports/imports 身份所依赖的 manifest。 */
        const manifest = path.join(dependency.root, 'package.json');
        observations.set(manifest, Object.freeze({
          path: manifest,
          type: 'file' as const,
          identity: `package:${dependency.name}@${dependency.version}/package.json`,
        }));
      }
      for (const [file, dependency] of packageEntries) {
        /** external module 不一定进入 Rolldown watchFiles，必须显式观察真实 entry。 */
        observations.set(file, Object.freeze({
          path: file,
          type: 'file' as const,
          identity: `package:${dependency.name}@${dependency.version}/${path.relative(dependency.root, file).split(path.sep).join('/')}`,
        }));
      }
      for (const manifest of resolutionManifests)
        observations.set(manifest, Object.freeze({ path: manifest, type: 'file' as const }));
      await this.#watch.replace(owner, `module/${request.id}`, [...observations.values()]);
      /** query 只用于本 Session fresh evaluation；不进入报告或输出。 */
      const namespace = await import(`${pathToFileURL(physical).href}?acplugin=${encodeURIComponent(request.id)}`) as Record<string, unknown>;
      if (!Object.prototype.hasOwnProperty.call(namespace, 'default'))
        throw new Error('Module Host entry must provide a default export.');
      return namespace.default as T;
    } finally {
      await bundle?.close();
    }
  }
}
