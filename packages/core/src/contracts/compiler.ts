import type {
  InputOptions,
  OutputOptions,
  Plugin,
} from 'rolldown';
import type {
  AssetMode,
  GeneratedAssetRef,
  SourceDirectoryRef,
  SourceFileRef,
} from './services.js';

/** portable-node 允许作者调整的只读字段。 */
type PortableReadonlyField<T> = T extends readonly (infer E)[] ? readonly E[] : T;

/** 从精确 Engine 类型派生只读 JSON 参数子集。 */
type PortableOptionSubset<T, K extends keyof T> = Readonly<{
  [P in K]?: PortableReadonlyField<NonNullable<T[P]>>;
}>;

/** portable-node 允许作者调整的解析参数。 */
export type PortableNodeResolveOptions = PortableOptionSubset<
  NonNullable<InputOptions['resolve']>,
  'conditionNames' | 'extensions' | 'mainFields' | 'mainFiles'
>;

/** portable-node 允许作者调整的转换参数。 */
export type PortableNodeTransformOptions = PortableOptionSubset<
  NonNullable<InputOptions['transform']>,
  'define' | 'dropLabels'
> & {
  readonly jsx?: false | 'react' | 'react-jsx' | 'preserve';
};

/** 固定 Node 20 ESM contract 内可复用的纯 JSON 编译参数。 */
export interface PortableNodeCompileOptions {
  readonly resolve?: PortableNodeResolveOptions;
  readonly transform?: PortableNodeTransformOptions;
  readonly treeshake?: Extract<InputOptions['treeshake'], boolean>;
}

/** Compiler Job 的来源或虚拟入口。 */
export type CompileEntry = {
  readonly type: 'source';
  readonly source: SourceFileRef;
  readonly mode?: AssetMode;
} | {
  readonly type: 'virtual';
  readonly code: string;
  readonly resolveFrom: SourceDirectoryRef;
  readonly mode?: AssetMode;
};

/** Core 支持的两个编译 Profile。 */
export type CompileProfile = 'portable-node' | 'managed-rolldown';

/** managed Profile 禁止接受但不执行的写入和 Watch Plugin Hook。 */
export type ForbiddenManagedPluginHook = 'writeBundle' | 'watchChange' | 'closeWatcher';

/** managed Profile 可调用的 Rolldown Plugin。 */
export type ManagedRolldownPlugin = Omit<Plugin, ForbiddenManagedPluginHook>;

/** Rolldown 风格的递归 Plugin option。 */
export type ManagedRolldownPluginOption = ManagedRolldownPlugin
  | { readonly name: string }
  | false
  | null
  | undefined
  | PromiseLike<ManagedRolldownPluginOption>
  | readonly ManagedRolldownPluginOption[];

/** Core 从 managed input options 中接管的字段。 */
type CoreOwnedManagedInputOption = 'input' | 'cwd' | 'plugins' | 'logLevel' | 'onwarn' | 'watch' | 'devtools' | 'output' | 'tsconfig';

/** trusted integration 可使用的 Rolldown input 能力。 */
export type ManagedRolldownInputOptions = Omit<InputOptions, CoreOwnedManagedInputOption> & {
  readonly plugins?: ManagedRolldownPluginOption;
  readonly tsconfig?: false | SourceFileRef;
};

/** trusted integration 可使用的 Rolldown output 能力。 */
export type ManagedRolldownOutputOptions = Omit<OutputOptions, 'dir' | 'file' | 'plugins'> & {
  readonly plugins?: ManagedRolldownPluginOption;
};

/** managed Profile 的输出与审计策略。 */
export interface ManagedRolldownCompileOptions {
  readonly inputOptions?: ManagedRolldownInputOptions;
  readonly outputs: readonly { readonly id: string; readonly options: ManagedRolldownOutputOptions }[];
  readonly policy?: {
    readonly deterministic?: boolean;
    readonly licenses?: 'strict' | 'ignore';
    readonly nativeAddons?: 'reject' | 'allow';
    readonly unresolvedImports?: 'reject' | 'allow';
  };
}

/** 编译 Profile 与其参数的唯一映射。 */
export interface CompileOptionsMap {
  readonly 'portable-node': PortableNodeCompileOptions;
  readonly 'managed-rolldown': ManagedRolldownCompileOptions;
}

/** 指定 Profile 的编译参数。 */
export type CompileOptions<P extends CompileProfile> = CompileOptionsMap[P];

/** 与当前所有者能力绑定的 Compiler Job。 */
export interface CompileJob<P extends CompileProfile> {
  readonly id: string;
  readonly profile: P;
  readonly entries: Readonly<Record<string, CompileEntry>>;
  readonly sourceScopes?: readonly SourceDirectoryRef[];
  readonly virtualModules?: Readonly<Record<string, string>>;
  readonly options?: CompileOptions<P>;
}

/** Compiler 输出的受管文件。 */
export interface CompileOutputFile {
  readonly type: 'chunk' | 'asset' | 'licenses';
  readonly outputId: string;
  readonly fileName: string;
  readonly entryId?: string;
  readonly isEntry: boolean;
  readonly asset: GeneratedAssetRef;
}

/** 脱敏后的 Compiler 模块图节点。 */
export interface CompileModuleReport {
  readonly id: string;
  readonly kind: 'source' | 'virtual' | 'package';
  readonly inputs: readonly string[];
  readonly importedBy: readonly string[];
}

/** Compiler Host 的稳定结果。 */
export interface CompileResult<P extends CompileProfile> {
  readonly job: string;
  readonly profile: P;
  readonly engine: { readonly name: 'rolldown'; readonly version: string };
  readonly outputs: readonly CompileOutputFile[];
  readonly modules: readonly CompileModuleReport[];
}

/** owner-scoped Compiler Host 能力。 */
export interface CompilerService {
  readonly engine: { readonly name: 'rolldown'; readonly version: string };
  /** 通过 Core 唯一 Compiler Host 执行 owner-scoped Job。 */
  compile<P extends CompileProfile>(job: CompileJob<P>): Promise<CompileResult<P>>;
}

/** Compiler Host 向 Asset Registry 提交的结构化生成来源。 */
export interface CompileAssetOriginInput {
  readonly job: string;
  readonly output: string;
  readonly profile: CompileProfile;
  readonly kind: CompileOutputFile['type'];
  readonly inputs: readonly string[];
}
