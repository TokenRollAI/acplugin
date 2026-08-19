import type {
  InputOptions,
  OutputOptions,
  Plugin,
  RolldownBuild,
  RolldownOutput,
} from 'rolldown';

/** SDK 从当前精确 Rolldown 依赖派生的输入参数。 */
export type EngineInputOptions = InputOptions;

/** SDK 从当前精确 Rolldown 依赖派生的输出参数。 */
export type EngineOutputOptions = OutputOptions;

/** SDK 从当前精确 Rolldown 依赖派生的 Plugin 结构。 */
export type EnginePlugin = Plugin;

/** Compiler Host 审计与签发使用的内存输出。 */
export type EngineOutput = RolldownOutput;

/** Compiler Host 唯一允许调用的 Rolldown bundle 能力。 */
export interface ManagedEngineBuild {
  /** 使用精确 Rolldown output options 生成内存产物。 */
  generate(options: OutputOptions): Promise<RolldownOutput>;
  /** 关闭当前原生 bundle 及 Plugin close lifecycle。 */
  close(): Promise<void>;
  readonly watchFiles: Promise<string[]>;
}

/** 动态加载后的精确 Rolldown 驱动器。 */
export interface ManagedEngine {
  readonly name: 'rolldown';
  readonly version: string;
  /** 仅通过 rolldown() 创建一个受管 bundle。 */
  create(input: InputOptions): Promise<ManagedEngineBuild>;
  /** 使用与 Compiler Host 相同 Rolldown 发行版解析 JS/TS 语法。 */
  parse(source: string, filename: string, language: 'js' | 'jsx' | 'ts' | 'tsx'): unknown;
}

/** 进程内共享的 Rolldown 动态加载结果。 */
let enginePromise: Promise<ManagedEngine> | undefined;

/**
 * 延迟加载 Core 唯一 Rolldown 驱动。
 *
 * @returns 版本直接来自当前 Rolldown 模块的最小驱动器。
 */
export function loadManagedEngine(): Promise<ManagedEngine> {
  enginePromise ??= Promise.all([import('rolldown'), import('rolldown/parseAst')]).then(([module, parser]) => {
    /** 解析器与 bundle 驱动在同一受管加载边界内取得，避免静态子路径依赖泄漏。 */
    const parseAst = parser.parseAst;
    /** 驱动只暴露 rolldown、generate、close 与受管 watchFiles。 */
    const engine: ManagedEngine = {
      name: 'rolldown',
      version: module.VERSION,
      /** 根据 Core 重建的 input options 创建原生 bundle。 */
      create: async (input): Promise<ManagedEngineBuild> => {
        /** 原生 bundle 始终被收缩到 Host 内部能力面。 */
        const bundle: RolldownBuild = await module.rolldown(input);
        return Object.freeze({
          /** 不暴露 write，只代理内存 generate。 */
          generate: (options: OutputOptions) => bundle.generate(options),
          /** 不暴露原生 bundle identity 的关闭代理。 */
          close: () => bundle.close(),
          /** 由 Host 在审计后统一消费 Rolldown watchFiles。 */
          get watchFiles() {
            return bundle.watchFiles;
          },
        });
      },
      /** portable policy 不引入第二套 parser。 */
      parse: (source, filename, language) => parseAst(source, { lang: language, sourceType: 'unambiguous' }, filename),
    };
    return Object.freeze(engine);
  });
  return enginePromise;
}
