import { promises as fs } from 'node:fs';
import path from 'node:path';
import type {
  CompileJob,
  CompileOutputFile,
  CompileProfile,
  CompileResult,
  CompilerService,
  ManagedRolldownCompileOptions,
  ManagedRolldownPlugin,
} from '../kernel-types.js';
import { AssetRegistry } from '../kernel/asset-registry.js';
import { compareCodePoints, isInsidePath, safeRelativePath } from '../kernel/path-policy.js';
import { SourceRegistry } from '../kernel/source-registry.js';
import { WatchRegistry, type WatchObservation } from '../kernel/watch-registry.js';
import { WorkDirectoryRegistry } from '../kernel/work-directories.js';
import {
  auditManagedModules,
  auditManagedOutput,
  managedModuleWatchObservations,
  managedModuleReports,
  type AuditedModule,
  type EngineModuleSnapshot,
  type ManagedAuditScopes,
} from './managed-auditor.js';
import { loadManagedEngine, type EngineInputOptions, type EngineOutputOptions, type ManagedEngine } from './engine-loader.js';
import {
  assertStableId,
  dataProperties,
  prepareCompileSources,
  resolveCompileSources,
  type NormalizedEntry,
  type VirtualSource,
} from './job-normalizer.js';
import { managedSourceBoundaryPlugin, type ManagedPackageScope } from './managed-boundary.js';
import { normalizeManagedInput, normalizeManagedOutput } from './managed-options.js';
import type { NormalizedManagedInput, NormalizedManagedOutput } from './managed-options.js';
import { auditPortableOutput, mergePortableModuleReports } from './portable-auditor.js';
import { collectCompilerLicenses, type CompilerLicenseResult } from './license-pipeline.js';
import { normalizePortableOptions, type NormalizedPortableOptions } from './portable-options.js';
import {
  assertPortableEntryExtension,
  normalizeNodeBuiltin,
  portableNodePolicyPlugin,
} from './portable-policy.js';

/** 单个 Compiler Host 使用的 Session registries。 */
export interface CompilerHostOptions {
  readonly projectRoot: string;
  readonly sources: SourceRegistry;
  readonly workDirectories: WorkDirectoryRegistry;
  readonly assets: AssetRegistry;
  readonly watch: WatchRegistry;
}

/** 快照并授权后的 managed job。 */
interface NormalizedManagedJob {
  readonly id: string;
  readonly entries: readonly NormalizedEntry[];
  readonly virtualSources: ReadonlyMap<string, VirtualSource>;
  readonly sourceRoots: readonly string[];
  readonly input: NormalizedManagedInput;
  readonly outputs: readonly { readonly id: string; readonly output: NormalizedManagedOutput }[];
  readonly policy?: ManagedRolldownCompileOptions['policy'];
}

/** 快照并授权后的 portable-node job。 */
interface NormalizedPortableJob {
  readonly id: string;
  readonly entries: readonly NormalizedEntry[];
  readonly virtualSources: ReadonlyMap<string, VirtualSource>;
  readonly sourceRoots: readonly string[];
  readonly options: NormalizedPortableOptions;
}

/**
 * 建立 Core 自有的虚拟 entry/module Plugin。
 *
 * @param sources 原生虚拟 ID 到代码的快照。
 * @returns 只处理当前 Job 精确虚拟 ID 的 Plugin。
 */
function virtualSourcePlugin(sources: ReadonlyMap<string, VirtualSource>): ManagedRolldownPlugin {
  return Object.freeze({
    name: 'acplugin-virtual-sources',
    /** 解析当前 Job 的虚拟 ID 和虚拟 entry 相对导入。 */
    resolveId(source, importer) {
      /** 公开 specifier 与内部 NUL ID 都只能命中已快照集合。 */
      if (sources.has(source))
        return source;
      /** 公开 specifier 对应的 Core 内部 NUL ID。 */
      const internal = `\0acplugin:module:${source}`;
      if (sources.has(internal))
        return internal;
      /** importer 对应的虚拟源快照。 */
      const record = importer === undefined ? undefined : sources.get(importer);
      if (record?.resolveFrom !== undefined && (source.startsWith('./') || source.startsWith('../')))
        return this.resolve(source, path.join(record.resolveFrom, '__acplugin_entry__.mjs'), { skipSelf: true });
      return null;
    },
    /** 为字符串动态 import 提供与静态 import 一致的解析。 */
    resolveDynamicImport(source, importer) {
      /** 字符串动态 import 与静态 import 使用相同虚拟解析规则。 */
      if (typeof source !== 'string')
        return null;
      /** 动态 importer 对应的虚拟源快照。 */
      const record = importer === undefined ? undefined : sources.get(importer);
      return record?.resolveFrom !== undefined && (source.startsWith('./') || source.startsWith('../'))
        ? path.resolve(record.resolveFrom, source)
        : null;
    },
    /** 返回当前 Job 已快照的虚拟源码。 */
    load(id) {
      return sources.get(id)?.code ?? null;
    },
  });
}

/**
 * 建立最终模块图采样 Plugin。
 *
 * 该 Plugin 可被 trusted Plugin 干扰，因此它只提供数据；Host 在
 * generate() 返回后独立验证图完整性与所有安全不变量。
 *
 * @param graph 当前 output 的原始模块图容器。
 * @returns 最后一个 generateBundle 采样器。
 */
function moduleGraphPlugin(graph: Map<string, EngineModuleSnapshot>): ManagedRolldownPlugin {
  return Object.freeze({
    name: 'acplugin-module-graph-audit',
    generateBundle: {
      order: 'post' as const,
      /** 在当次 output 所有 Plugin 完成后采样最终模块图。 */
      handler(_options, outputBundle) {
        graph.clear();
        /** 只读取 ModuleInfo 的四个审计数组，避免触发 ast 等不支持 getter。 */
        const capture = (id: string): void => {
          /** 当前 ID 对应的 Rolldown 模块信息。 */
          const info = this.getModuleInfo(id);
          if (info !== null) {
            graph.set(id, Object.freeze({
              importedIds: Object.freeze([...info.importedIds]),
              dynamicallyImportedIds: Object.freeze([...info.dynamicallyImportedIds]),
              importers: Object.freeze([...info.importers]),
              dynamicImporters: Object.freeze([...info.dynamicImporters]),
            }));
          }
        };
        for (const id of this.getModuleIds()) {
          capture(id);
        }
        /** Rolldown output 有时保留与 getModuleIds() 不同的规范 ID，两者必须同时采样。 */
        for (const item of Object.values(outputBundle)) {
          if (item.type === 'chunk') {
            for (const id of [...item.moduleIds, ...Object.keys(item.modules)])
              capture(id);
          }
        }
      },
    },
  });
}

/**
 * 把 Rolldown watch file 限制在已审计模块或 owner workDir。
 *
 * @param file Rolldown/Plugin 登记的物理路径。
 * @param modules 已通过最终边界审计的模块。
 * @param scopes 当前 owner 授权根。
 * @returns 可交给唯一 DevSession watcher 的规范路径。
 */
async function auditedWatchFile(
  file: string,
  modules: readonly AuditedModule[],
  scopes: ManagedAuditScopes,
): Promise<WatchObservation> {
  if (typeof file !== 'string' || file.includes('\0') || !path.isAbsolute(file))
    throw new Error('Managed Rolldown watch files must be absolute physical paths.');
  /** existing 使用 realpath；missing 通过最深已存在祖先进入相同真实路径基准。 */
  const existing = await fs.realpath(file).catch(() => undefined);
  /** 尚未创建部分从目标向已存在祖先反向积累。 */
  const suffix: string[] = [];
  /** missing watch 候选的当前祖先。 */
  let ancestor = path.normalize(file);
  while (existing === undefined && !await fs.lstat(ancestor).then(() => true).catch(() => false)) {
    /** 当前祖先的父目录用于检测文件系统根并继续向上。 */
    const parent = path.dirname(ancestor);
    if (parent === ancestor)
      throw new Error('Managed Rolldown watch file has no existing ancestor.');
    suffix.push(path.basename(ancestor));
    ancestor = parent;
  }
  /** 已存在祖先本身不能是 symlink/special file。 */
  const ancestorStat = existing === undefined ? await fs.lstat(ancestor) : undefined;
  if (ancestorStat !== undefined && (ancestorStat.isSymbolicLink() || !ancestorStat.isDirectory()))
    throw new Error('Managed Rolldown watch file must have a regular directory ancestor.');
  /** canonical missing path 保留尚不存在的最终 segment。 */
  const normalized = existing ?? path.join(await fs.realpath(ancestor), ...suffix.reverse());
  /** missing watch file 只能位于 source root；workDir 不作为作者恢复入口。 */
  const pending = existing === undefined;
  /** 最终模块图中的全部物理文件。 */
  const moduleFiles = new Set(modules
    .map(module => module.physicalId.replace(/\?.*$/u, ''))
    .filter(id => path.isAbsolute(id))
    .map(id => path.normalize(id)));
  /** 当前观察是否位于 owner 已授权的源码根。 */
  const inSource = scopes.sourceRoots.some(root => isInsidePath(root, normalized));
  /** pending 只能位于 source；existing 还可属于最终 module graph 或 owner workDir。 */
  const inWork = isInsidePath(scopes.workRoot, normalized);
  if (!moduleFiles.has(normalized) && !inSource && (pending || !inWork)) {
    throw new Error('Managed Rolldown registered a watch file outside its authorized module graph.');
  }
  return Object.freeze({ path: normalized, type: 'file' as const, ...(pending ? { pending: true } : {}) });
}

/** Core 唯一的、可为多 owner 签发 service 的 Compiler Host。 */
export class CompilerHost {
  /** 工程绝对根，用于 Rolldown cwd 和报告路径。 */
  readonly #projectRoot: string;
  /** SourceRef 对象 identity 授权注册表。 */
  readonly #sources: SourceRegistry;
  /** owner workDir 对象 identity 授权注册表。 */
  readonly #workDirectories: WorkDirectoryRegistry;
  /** GeneratedAssetRef 唯一签发注册表。 */
  readonly #assets: AssetRegistry;
  /** BuildSession 唯一 Watch Registry。 */
  readonly #watch: WatchRegistry;
  /** 进程内精确 Rolldown 驱动的延迟加载结果。 */
  readonly #engine: Promise<ManagedEngine>;
  /** owner 内已消费 job ID，防止 workDir 结果被重用。 */
  readonly #jobs = new Map<string, Set<string>>();

  /**
   * 创建一个 BuildSession 唯一 Compiler Host。
   *
   * @param options 当前 Session 的 capability registries 与 Watch 出口。
   */
  constructor(options: CompilerHostOptions) {
    this.#projectRoot = path.resolve(options.projectRoot);
    this.#sources = options.sources;
    this.#workDirectories = options.workDirectories;
    this.#assets = options.assets;
    this.#watch = options.watch;
    this.#engine = loadManagedEngine();
  }

  /**
   * 为一个 Integration/Framework owner 创建闭包绑定的 CompilerService。
   *
   * @param owner Kernel 固定的 owner ID。
   * @returns 不接受调用方自报 owner 的 SDK service。
   */
  async service(owner: string): Promise<CompilerService> {
    if (typeof owner !== 'string' || owner.length === 0)
      throw new TypeError('Compiler owner must be a non-empty string.');
    /** 当前安装的精确 Rolldown 驱动。 */
    const engine = await this.#engine;
    /** engine 信息和 compile 闭包不暴露 Host 或 registries。 */
    return Object.freeze({
      engine: Object.freeze({ name: engine.name, version: engine.version }),
      /** 编译请求自动绑定当前 owner。 */
      compile: <P extends CompileProfile>(job: CompileJob<P>) => this.#compile(owner, engine, job),
    });
  }

  /**
   * 快照并授权 managed Job 全部来源。
   *
   * @param owner 当前 service owner。
   * @param job 调用方 Job。
   * @returns 已与调用方容器解除引用的内部请求。
   */
  async #normalizeManaged(owner: string, job: CompileJob<'managed-rolldown'>): Promise<NormalizedManagedJob> {
    /** Job 公共来源在任何异步 Plugin/I/O 之前完成容器快照。 */
    const pending = prepareCompileSources(owner, 'managed-rolldown', job, this.#sources);
    /** managed Profile 的原始 options 容器。 */
    const options = pending.options;
    /** managed options 的全部 data property。 */
    const optionDescriptors = dataProperties(options, 'Managed compile options');
    for (const field of Object.keys(optionDescriptors)) {
      if (!new Set(['inputOptions', 'outputs', 'policy']).has(field))
        throw new TypeError(`Managed compile options.${field} is unknown.`);
    }
    if (!Array.isArray(optionDescriptors.outputs?.value) || optionDescriptors.outputs.value.length === 0)
      throw new TypeError('Managed compile options.outputs must be a non-empty array.');
    /** output 数组在任何 Plugin Promise await 前复制当前元素。 */
    const rawOutputs = [...optionDescriptors.outputs.value] as unknown[];
    /** 当前 Job 已声明的唯一 output ID。 */
    const outputIds = new Set<string>();
    /** input 参数在任何 Plugin Promise 解析前同步建立容器快照。 */
    const inputPromise = normalizeManagedInput(optionDescriptors.inputOptions?.value);
    /** 后续同步字段验证失败时也必须立即观察 Plugin Promise rejection。 */
    void inputPromise.catch(() => undefined);
    /** 所有 output 先同步读取 descriptor，不让前一个 Promise 打开 mutation 窗口。 */
    const outputPromises = rawOutputs.map((rawOutput, index) => {
      /** 当前 output 的全部 data property。 */
      const output = dataProperties(rawOutput, `Managed output[${index}]`);
      for (const field of Object.keys(output)) {
        if (field !== 'id' && field !== 'options')
          throw new TypeError(`Managed output[${index}].${field} is unknown.`);
      }
      assertStableId(output.id?.value, 'Managed output id');
      /** 经过 ID assertion 后固定当前输出身份。 */
      const outputId = output.id.value;
      if (outputIds.has(outputId))
        throw new TypeError(`Managed output id "${outputId}" is duplicated.`);
      outputIds.add(outputId);
      /** 当前 output 的异步 Plugin 解析与结构快照。 */
      const outputPromise = normalizeManagedOutput(output.options?.value, `Managed output "${outputId}" options`).then(normalized => Object.freeze({
        id: outputId,
        output: normalized,
      }));
      /** 任何后续 output/policy 同步失败都不能留下未观察 rejection。 */
      void outputPromise.catch(() => undefined);
      return outputPromise;
    });
    /** 调用方提供的原始审计策略。 */
    const rawPolicy = optionDescriptors.policy?.value;
    /** policy 是小型数据对象，逐字段复制并校验。 */
    let policy: ManagedRolldownCompileOptions['policy'];
    if (rawPolicy !== undefined) {
      /** 审计策略的全部 data property。 */
      const values = dataProperties(rawPolicy, 'Managed compile policy');
      /** 当前 managed Profile 已定义的策略字段。 */
      const allowed = new Set(['deterministic', 'licenses', 'nativeAddons', 'unresolvedImports']);
      for (const field of Object.keys(values)) {
        if (!allowed.has(field))
          throw new TypeError(`Managed compile policy.${field} is unknown.`);
      }
      if (values.deterministic !== undefined && typeof values.deterministic.value !== 'boolean')
        throw new TypeError('Managed compile policy.deterministic must be boolean.');
      if (values.licenses !== undefined && values.licenses.value !== 'strict' && values.licenses.value !== 'ignore')
        throw new TypeError('Managed compile policy.licenses must be strict or ignore.');
      if (values.nativeAddons !== undefined && values.nativeAddons.value !== 'reject' && values.nativeAddons.value !== 'allow')
        throw new TypeError('Managed compile policy.nativeAddons must be reject or allow.');
      if (values.unresolvedImports !== undefined && values.unresolvedImports.value !== 'reject' && values.unresolvedImports.value !== 'allow')
        throw new TypeError('Managed compile policy.unresolvedImports must be reject or allow.');
      policy = Object.freeze({
        ...(values.deterministic === undefined ? {} : { deterministic: values.deterministic.value as boolean }),
        ...(values.licenses === undefined ? {} : { licenses: values.licenses.value as 'strict' | 'ignore' }),
        ...(values.nativeAddons === undefined ? {} : { nativeAddons: values.nativeAddons.value as 'reject' | 'allow' }),
        ...(values.unresolvedImports === undefined ? {} : { unresolvedImports: values.unresolvedImports.value as 'reject' | 'allow' }),
      });
    }
    /** 到此才执行来源树 I/O；调用方容器已完全断开。 */
    const normalizedSources = await resolveCompileSources(owner, pending, this.#sources);
    /** Plugin Promise 已解析且结构快照完成的 input options。 */
    const normalizedInput = await inputPromise;
    /** managed tsconfig 只接受当前 owner/Session 的精确 SourceFileRef。 */
    let tsconfig: string | false = false;
    if (normalizedInput.tsconfig !== undefined && normalizedInput.tsconfig !== false) {
      /** SourceRegistry 授权并复核后的 tsconfig 文件记录。 */
      const record = await this.#sources.validatedFile(owner, normalizedInput.tsconfig);
      tsconfig = await fs.realpath(record.physicalPath);
    }
    return Object.freeze({
      id: normalizedSources.id,
      entries: normalizedSources.entries,
      virtualSources: normalizedSources.virtualSources,
      sourceRoots: normalizedSources.sourceRoots,
      input: Object.freeze({
        ...normalizedInput,
        options: Object.freeze({ ...normalizedInput.options, tsconfig }),
      }),
      outputs: Object.freeze(await Promise.all(outputPromises)),
      ...(policy === undefined ? {} : { policy }),
    });
  }

  /**
   * 快照并授权 portable-node Job 全部来源和 JSON options。
   *
   * @param owner 当前 service owner。
   * @param job 调用方 portable Job。
   * @returns 固定 Node contract 可直接执行的内部请求。
   */
  async #normalizePortable(owner: string, job: CompileJob<'portable-node'>): Promise<NormalizedPortableJob> {
    /** 来源和 options 都在第一个 I/O 前完成同步容器快照。 */
    const pending = prepareCompileSources(owner, 'portable-node', job, this.#sources);
    /** portable JSON subset 的运行时快照。 */
    const options = normalizePortableOptions(pending.options);
    /** 已通过作者树和 SourceRef 复核的物理来源。 */
    const sources = await resolveCompileSources(owner, pending, this.#sources);
    for (const entry of sources.entries)
      assertPortableEntryExtension(entry.inputId);
    return Object.freeze({ ...sources, options });
  }

  /**
   * 消费 owner 内唯一 Job ID。
   *
   * @param owner 当前 service owner。
   * @param id 已规范化 stable Job ID。
   */
  #consumeJob(owner: string, id: string): void {
    /** owner 间相同 ID 不冲突，同 owner 当次 Session 不能覆盖既有 work 输出。 */
    const jobs = this.#jobs.get(owner) ?? new Set<string>();
    if (jobs.has(id))
      throw new Error(`Compile job id "${id}" was already used by this owner.`);
    jobs.add(id);
    this.#jobs.set(owner, jobs);
  }

  /**
   * 执行 owner-scoped Compiler Job。
   *
   * @param owner 当前 service owner。
   * @param engine 已加载精确 Rolldown 驱动。
   * @param job SDK Job。
   * @returns 仅包含 GeneratedAssetRef 与脱敏模块图的结果。
   */
  async #compile<P extends CompileProfile>(
    owner: string,
    engine: ManagedEngine,
    job: CompileJob<P>,
  ): Promise<CompileResult<P>> {
    if (job.profile === 'portable-node')
      return this.#compilePortable(owner, engine, job as CompileJob<'portable-node'>) as Promise<CompileResult<P>>;
    if (job.profile !== 'managed-rolldown')
      throw new Error('Compile profile is not supported by this Core version.');
    /** 与调用方容器隔离且完成来源授权的 Job。 */
    const normalized = await this.#normalizeManaged(owner, job as CompileJob<'managed-rolldown'>);
    /** job ID 在开始任何引擎工作前一次性消费。 */
    this.#consumeJob(owner, normalized.id);
    /** 当前 owner 的唯一 workDir 句柄。 */
    const workDirectory = await this.#workDirectories.directory(owner);
    /** 仅 Core 可见的 owner 物理工作根。 */
    const workRoot = this.#workDirectories.physicalRoot(owner, workDirectory);
    /** 只有 source boundary resolver 证明的 package 才可通过最终审计。 */
    const packages = new Map<string, ManagedPackageScope>();
    /** 最终 resolver/module/output/watch 共用的审计边界。 */
    const scopes = Object.freeze({
      projectRoot: await fs.realpath(this.#projectRoot),
      sourceRoots: normalized.sourceRoots,
      workRoot,
      packages,
    });
    /** Core 从 entry ID 独立建立 Rolldown 命名 input。 */
    const input = Object.freeze(Object.fromEntries(normalized.entries.map(entry => [entry.id, entry.inputId])));
    /** 已展平并快照的 trusted input Plugin。 */
    const userPlugins = normalized.input.plugins;
    /** Core 重建入口、cwd、日志和 watch 边界的最终 input options。 */
    const inputOptions = Object.freeze({
      ...normalized.input.options,
      input,
      cwd: this.#projectRoot,
      logLevel: 'silent' as const,
      watch: false,
      plugins: [
        managedSourceBoundaryPlugin({ sourceRoots: normalized.sourceRoots, workRoot, packages }),
        ...userPlugins,
        virtualSourcePlugin(normalized.virtualSources),
      ],
    });
    /** create 成功后无论 generate/audit/sign 如何失败都必须 close。 */
    let bundle: Awaited<ReturnType<ManagedEngine['create']>> | undefined;
    try {
      bundle = await engine.create(inputOptions);
      /** 多 output 按声明顺序依次调用同一 build object generate()。 */
      const outputs: CompileOutputFile[] = [];
      /** 第一个 output 确定且后续 output 必须一致的模块报告。 */
      let moduleReports: ReturnType<typeof managedModuleReports> | undefined;
      /** 同一 managed Job 全部 output 的最终 watch observations。 */
      const watchObservations = new Map<string, WatchObservation>();
      /** 所有签发 Asset 共享最终完整模块来源。 */
      let originInputs: readonly string[] = [];
      for (const output of normalized.outputs) {
        /** deterministic 模式必须避免 Rolldown 非 whitespace 输出注入物理 module region。 */
        if (normalized.policy?.deterministic === true && output.output.options.minify === false)
          throw new TypeError('Managed deterministic output cannot disable whitespace normalization.');
        /** 未指定 minify 时只规范 whitespace，不压缩表达式或改写名称。 */
        const effectiveOutput = normalized.policy?.deterministic === true && output.output.options.minify === undefined
          ? Object.freeze({ ...output.output.options, minify: Object.freeze({ compress: false, mangle: false }) })
          : output.output.options;
        /** 每个 output 独立采样当次 generate 的最终图。 */
        const graph = new Map<string, EngineModuleSnapshot>();
        /** Rolldown generate() 返回的原始内存输出。 */
        const raw = await bundle.generate(Object.freeze({
          ...effectiveOutput,
          plugins: [
            ...output.output.plugins,
            moduleGraphPlugin(graph),
          ],
        }));
        /** 在 Plugin 顺序之外通过的最终模块图。 */
        const modules = await auditManagedModules(graph, scopes);
        /** 通过路径、闭包和策略审计的内存输出。 */
        const files = auditManagedOutput(raw, modules, normalized.policy, [
          this.#projectRoot,
          scopes.projectRoot,
          scopes.workRoot,
          ...scopes.sourceRoots,
          ...[...scopes.packages.values()].map(dependency => dependency.root),
        ]);
        /** managed 默认 strict；显式 ignore 才由可信集成自行承担法律材料。 */
        const licenses: CompilerLicenseResult = normalized.policy?.licenses === 'ignore'
          ? Object.freeze({ inputs: Object.freeze([] as string[]), watchFiles: Object.freeze([] as string[]) })
          : await collectCompilerLicenses(modules, packages);
        if (licenses.bytes !== undefined && files.some(file => file.fileName === 'THIRD_PARTY_LICENSES.txt'))
          throw new Error('Managed Rolldown output conflicts with Core license material.');
        if (moduleReports === undefined) {
          moduleReports = managedModuleReports(modules);
          originInputs = Object.freeze(moduleReports.map(module => module.id).sort(compareCodePoints));
        } else if (JSON.stringify(moduleReports) !== JSON.stringify(managedModuleReports(modules))) {
          throw new Error('Managed Rolldown multi-output builds must expose one stable module graph.');
        }
        for (const file of files) {
          /** output ID 与 fileName 分层写入 owner workDir，不会碰触 dist。 */
          const relative = safeRelativePath(`compile/${normalized.id}/${output.id}/${file.fileName}`);
          /** owner workDir 内的唯一物理输出路径。 */
          const physical = this.#workDirectories.resolve(owner, workDirectory, relative);
          await fs.mkdir(path.dirname(physical), { recursive: true, mode: 0o700 });
          await fs.writeFile(physical, file.bytes, { flag: 'wx', mode: 0o600 });
          /** 用于继承 mode 的入口声明。 */
          const entry = file.entryId === undefined
            ? undefined
            : normalized.entries.find(candidate => candidate.id === file.entryId);
          /** 经 Asset Registry 签发的不可伪造输出 ref。 */
          const asset = await this.#assets.issueGenerated(
            owner,
            workDirectory,
            relative,
            entry?.mode ?? 0o644,
            { job: normalized.id, output: output.id, profile: 'managed-rolldown', kind: file.type, inputs: originInputs },
          );
          outputs.push(Object.freeze({
            type: file.type,
            outputId: output.id,
            fileName: file.fileName,
            ...(file.entryId === undefined ? {} : { entryId: file.entryId }),
            isEntry: file.isEntry,
            asset,
          }));
        }
        if (licenses.bytes !== undefined) {
          /** 当前 managed output 相邻的固定法律材料路径。 */
          const relative = safeRelativePath(`compile/${normalized.id}/${output.id}/THIRD_PARTY_LICENSES.txt`);
          /** 法律材料只写当前 owner workDir。 */
          const physical = this.#workDirectories.resolve(owner, workDirectory, relative);
          await fs.writeFile(physical, licenses.bytes, { flag: 'wx', mode: 0o600 });
          /** managed 法律材料也保留完整 compile provenance。 */
          const asset = await this.#assets.issueGenerated(
            owner,
            workDirectory,
            relative,
            0o644,
            { job: normalized.id, output: output.id, profile: 'managed-rolldown', kind: 'licenses', inputs: [...originInputs, ...licenses.inputs] },
          );
          outputs.push(Object.freeze({
            type: 'licenses' as const,
            outputId: output.id,
            fileName: 'THIRD_PARTY_LICENSES.txt',
            isEntry: false,
            asset,
          }));
        }
        /** 最终模块图中的 package 文件保留逻辑 watch identity。 */
        for (const observation of managedModuleWatchObservations(modules))
          watchObservations.set(observation.path, observation);
        /** Plugin/Rolldown watchFiles 必须位于已授权图边界。 */
        for (const file of (await bundle.watchFiles).sort(compareCodePoints)) {
          /** 当前 Plugin watch file 的授权后真实路径。 */
          const audited = await auditedWatchFile(file, modules, scopes);
          watchObservations.set(audited.path, watchObservations.get(audited.path) ?? audited);
        }
        /** package manifest/legal 使用安全 package identity。 */
        for (const file of licenses.watchFiles) {
          /** 当前法律文件所属的 resolver-proven package。 */
          const dependency = [...packages.values()].find(candidate => isInsidePath(candidate.root, file));
          watchObservations.set(file, Object.freeze({
            path: file,
            type: 'file' as const,
            ...(dependency === undefined ? {} : { identity: `package:${dependency.name}@${dependency.version}/${path.basename(file)}` }),
          }));
        }
      }
      await this.#watch.replace(owner, `compiler/${normalized.id}`, [...watchObservations.values()]);
      return Object.freeze({
        job: normalized.id,
        profile: 'managed-rolldown',
        engine: Object.freeze({ name: engine.name, version: engine.version }),
        outputs: Object.freeze(outputs),
        modules: moduleReports ?? Object.freeze([]),
      }) as CompileResult<P>;
    } finally {
      await bundle?.close();
    }
  }

  /**
   * 使用固定 Node 20 ESM policy 为每个入口生成独立 self-contained Bundle。
   *
   * @param owner 当前 service owner。
   * @param engine Core 唯一 Rolldown driver。
   * @param job portable-node Job。
   * @returns main/license GeneratedAssetRef 与合并后的安全模块图。
   */
  async #compilePortable(
    owner: string,
    engine: ManagedEngine,
    job: CompileJob<'portable-node'>,
  ): Promise<CompileResult<'portable-node'>> {
    /** 完成全部 Ref/options 授权后才消费 Job ID。 */
    const normalized = await this.#normalizePortable(owner, job);
    this.#consumeJob(owner, normalized.id);
    /** 当前 owner 的唯一 workDir 与内部物理根。 */
    const workDirectory = await this.#workDirectories.directory(owner);
    /** 只有 Host 可见的 owner workDir 根。 */
    const workRoot = this.#workDirectories.physicalRoot(owner, workDirectory);
    /** 用于来源报告和路径泄露审计的工程真实根。 */
    const projectRoot = await fs.realpath(this.#projectRoot);
    /** 多入口结果按稳定 entry ID 顺序生成和返回。 */
    const outputs: CompileOutputFile[] = [];
    /** 各独立入口的脱敏模块报告。 */
    const reports: ReturnType<typeof managedModuleReports>[] = [];
    /** 整个 portable Job 的统一 watch observation snapshot。 */
    const watchObservations = new Map<string, WatchObservation>();
    for (const entry of normalized.entries) {
      /** 每个入口独立证明实际打包 package graph，不共享 Chunk 或 license 集合。 */
      const packages = new Map<string, ManagedPackageScope>();
      /** 当前 entry 的完整最终审计边界。 */
      const scopes = Object.freeze({ projectRoot, sourceRoots: normalized.sourceRoots, workRoot, packages });
      /** Core policy Plugin 不由调用方提供或排序。 */
      const graph = new Map<string, EngineModuleSnapshot>();
      /** readonly SDK options 在 Core 边界转换为 Rolldown 当前需要的 mutable array copies。 */
      const resolve = normalized.options.resolve === undefined
        ? undefined
        : {
            ...(normalized.options.resolve.conditionNames === undefined ? {} : { conditionNames: [...normalized.options.resolve.conditionNames] }),
            ...(normalized.options.resolve.extensions === undefined ? {} : { extensions: [...normalized.options.resolve.extensions] }),
            ...(normalized.options.resolve.mainFields === undefined ? {} : { mainFields: [...normalized.options.resolve.mainFields] }),
            ...(normalized.options.resolve.mainFiles === undefined ? {} : { mainFiles: [...normalized.options.resolve.mainFiles] }),
          };
      /** transform 同样只复制 portable subset，不允许 Core-owned 字段混入。 */
      const transform = normalized.options.transform === undefined
        ? { target: 'node20' }
        : {
            ...(normalized.options.transform.define === undefined ? {} : { define: { ...normalized.options.transform.define } }),
            ...(normalized.options.transform.dropLabels === undefined ? {} : { dropLabels: [...normalized.options.transform.dropLabels] }),
            ...(normalized.options.transform.jsx === undefined ? {} : { jsx: normalized.options.transform.jsx }),
            target: 'node20',
          };
      /** Core 完整重建且不接受调用方 Plugin 的固定 input options。 */
      const inputOptions: EngineInputOptions = {
        input: Object.freeze({ [entry.id]: entry.inputId }),
        cwd: this.#projectRoot,
        platform: 'node' as const,
        tsconfig: false,
        logLevel: 'silent' as const,
        watch: false,
        /** 只有已经规范化的 node: builtin 可以保持 external。 */
        external: (id: string) => id.startsWith('node:') && normalizeNodeBuiltin(id) === id,
        ...(resolve === undefined ? {} : { resolve }),
        treeshake: normalized.options.treeshake ?? true,
        transform,
        plugins: [
          managedSourceBoundaryPlugin({ sourceRoots: normalized.sourceRoots, workRoot, packages }),
          portableNodePolicyPlugin(engine),
          virtualSourcePlugin(normalized.virtualSources),
        ],
      };
      /** 单入口 create/generate/close 完全由 Core 接管。 */
      let bundle: Awaited<ReturnType<ManagedEngine['create']>> | undefined;
      try {
        bundle = await engine.create(inputOptions);
        /** portable 唯一 output 参数完全由 Core 固定。 */
        const outputOptions: EngineOutputOptions = {
          format: 'es' as const,
          entryFileNames: 'main.mjs',
          chunkFileNames: 'main.mjs',
          assetFileNames: 'asset',
          sourcemap: false,
          codeSplitting: false,
          comments: { legal: true },
          /** Rolldown 1.2.2 的非 whitespace 模式会注入绝对 module region；固定压缩空白但不改名/压缩表达式。 */
          minify: { compress: false, mangle: false },
          plugins: [moduleGraphPlugin(graph)],
        };
        /** Rolldown generate-only 的原始内存输出。 */
        const raw = await bundle.generate(outputOptions);
        /** 最终模块图、输出闭包和物理路径都在 Plugin 链外复核。 */
        const modules = await auditManagedModules(graph, scopes);
        /** 固定单 Chunk 以及 residual/path policy 审计结果。 */
        const audited = auditPortableOutput(raw, entry.id, modules, [
          projectRoot,
          workRoot,
          ...normalized.sourceRoots,
          ...[...packages.values()].map(dependency => dependency.root),
        ]);
        /** 当前 entry 的安全公开模块报告。 */
        const report = managedModuleReports(audited.modules);
        reports.push(report);
        /** main/license GeneratedAsset origin 使用的逻辑来源。 */
        const originInputs = report.map(module => module.id).sort(compareCodePoints);
        /** main.mjs 只能落入当前 owner workDir。 */
        const mainRelative = safeRelativePath(`compile/${normalized.id}/${entry.id}/main.mjs`);
        /** main.mjs 在 owner workDir 中的私有物理路径。 */
        const mainPhysical = this.#workDirectories.resolve(owner, workDirectory, mainRelative);
        await fs.mkdir(path.dirname(mainPhysical), { recursive: true, mode: 0o700 });
        await fs.writeFile(mainPhysical, audited.bytes, { flag: 'wx', mode: 0o600 });
        /** 主 bundle 的不可伪造 GeneratedAssetRef。 */
        const mainAsset = await this.#assets.issueGenerated(
          owner,
          workDirectory,
          mainRelative,
          entry.mode,
          { job: normalized.id, output: entry.id, profile: 'portable-node', kind: 'chunk', inputs: originInputs },
        );
        outputs.push(Object.freeze({
          type: 'chunk' as const,
          outputId: entry.id,
          fileName: 'main.mjs',
          entryId: entry.id,
          isEntry: true,
          asset: mainAsset,
        }));
        /** 实际进入当前独立 bundle 的第三方包才生成相邻法律材料。 */
        const licenses = await collectCompilerLicenses(audited.modules, packages);
        if (licenses.bytes !== undefined) {
          /** 与 entry 相邻的稳定法律材料 workDir 路径。 */
          const licenseRelative = safeRelativePath(`compile/${normalized.id}/${entry.id}/THIRD_PARTY_LICENSES.txt`);
          /** 法律材料在 owner workDir 中的私有物理路径。 */
          const licensePhysical = this.#workDirectories.resolve(owner, workDirectory, licenseRelative);
          await fs.writeFile(licensePhysical, licenses.bytes, { flag: 'wx', mode: 0o600 });
          /** 法律材料自身的 GeneratedAssetRef。 */
          const licenseAsset = await this.#assets.issueGenerated(
            owner,
            workDirectory,
            licenseRelative,
            0o644,
            { job: normalized.id, output: entry.id, profile: 'portable-node', kind: 'licenses', inputs: [...originInputs, ...licenses.inputs] },
          );
          outputs.push(Object.freeze({
            type: 'licenses' as const,
            outputId: entry.id,
            fileName: 'THIRD_PARTY_LICENSES.txt',
            entryId: entry.id,
            isEntry: false,
            asset: licenseAsset,
          }));
        }
        /** 实际模块、manifest 与法律文件进入同一内部 Watch Registry。 */
        for (const observation of managedModuleWatchObservations(audited.modules))
          watchObservations.set(observation.path, observation);
        for (const file of await bundle.watchFiles) {
          /** 当前 Rolldown watch file 的授权后真实路径。 */
          const watched = await auditedWatchFile(file, audited.modules, scopes);
          watchObservations.set(watched.path, watchObservations.get(watched.path) ?? watched);
        }
        for (const file of licenses.watchFiles) {
          /** 当前法律文件所属的 resolver-proven package。 */
          const dependency = [...packages.values()].find(candidate => isInsidePath(candidate.root, file));
          watchObservations.set(file, Object.freeze({
            path: file,
            type: 'file' as const,
            ...(dependency === undefined ? {} : { identity: `package:${dependency.name}@${dependency.version}/${path.basename(file)}` }),
          }));
        }
      } finally {
        await bundle?.close();
      }
    }
    await this.#watch.replace(owner, `compiler/${normalized.id}`, [...watchObservations.values()]);
    return Object.freeze({
      job: normalized.id,
      profile: 'portable-node',
      engine: Object.freeze({ name: engine.name, version: engine.version }),
      outputs: Object.freeze(outputs),
      modules: mergePortableModuleReports(reports),
    });
  }
}
