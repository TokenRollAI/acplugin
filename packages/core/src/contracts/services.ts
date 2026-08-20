/** 安全的工程相对来源位置。 */
export interface SourceLocation {
  readonly path: string;
  readonly line?: number;
  readonly column?: number;
}

/** 生命周期可以提交的稳定诊断。 */
export interface DiagnosticInput {
  readonly code: string;
  readonly severity: 'warning' | 'error';
  readonly message: string;
  readonly location?: SourceLocation;
  readonly fieldPath?: readonly (string | number)[];
  readonly hint?: string;
}

/** 绑定 owner 和 phase 的诊断服务。 */
export interface DiagnosticService {
  /** 向当前 owner 和 phase 提交一条结构化诊断。 */
  report(input: DiagnosticInput): void;
}

/** Core 签发的源码目录能力；运行时授权依赖 Session 对象身份。 */
declare const sourceDirectoryTypeBrand: unique symbol;

/** Core 签发的源码文件能力；运行时授权依赖 Session 对象身份。 */
declare const sourceFileTypeBrand: unique symbol;

/** Source Registry 签发的来源 Asset 类型品牌。 */
declare const sourceAssetTypeBrand: unique symbol;

/** Compiler Host 签发的生成 Asset 类型品牌。 */
declare const generatedAssetTypeBrand: unique symbol;

/** Asset Service 签发的内存字节 Asset 类型品牌。 */
declare const bytesAssetTypeBrand: unique symbol;

/** Core 签发的源码目录能力；运行时授权依赖 Session 对象身份。 */
export interface SourceDirectoryRef {
  readonly kind: 'source-directory';
  readonly path: string;
  readonly [sourceDirectoryTypeBrand]: true;
}

/** Core 签发的源码文件能力；运行时授权依赖 Session 对象身份。 */
export interface SourceFileRef {
  readonly kind: 'source-file';
  readonly path: string;
  readonly [sourceFileTypeBrand]: true;
}

/** Source Service 返回的已验证目录项。 */
export type SourceEntry = {
  readonly type: 'file';
  readonly name: string;
  readonly path: string;
  readonly file: SourceFileRef;
} | {
  readonly type: 'directory';
  readonly name: string;
  readonly path: string;
  readonly directory: SourceDirectoryRef;
};

/** owner-scoped 源码读取能力。 */
export interface SourceService {
  /** 枚举一个已授权来源目录。 */
  list(directory: SourceDirectoryRef, options?: { readonly recursive?: boolean }): Promise<readonly SourceEntry[]>;
  /** 从已授权目录签发后代文件 ref。 */
  file(directory: SourceDirectoryRef, relativePath: string): Promise<SourceFileRef>;
  /** 从已授权目录签发后代目录 ref。 */
  directory(directory: SourceDirectoryRef, relativePath: string): Promise<SourceDirectoryRef>;
  /** 在读取上限内复制来源文件字节。 */
  read(file: SourceFileRef, options?: { readonly maxBytes?: number }): Promise<Uint8Array>;
  /** 在读取上限内以 UTF-8 解码来源文件。 */
  readText(file: SourceFileRef, options?: { readonly maxBytes?: number }): Promise<string>;
}

/** 可信结构化 ESM 作者模块的加载服务。 */
export interface ModuleService {
  /** 执行受管 ESM 图并返回其 default export。 */
  loadDefault<T = unknown>(request: { readonly id: string; readonly entry: SourceFileRef }): Promise<T>;
}

/** Source Registry 签发的来源 Asset。 */
export interface SourceAssetRef {
  readonly kind: 'source-asset';
  readonly id: string;
  readonly [sourceAssetTypeBrand]: true;
}

/** Compiler Host 签发的生成 Asset。 */
export interface GeneratedAssetRef {
  readonly kind: 'generated-asset';
  readonly id: string;
  readonly [generatedAssetTypeBrand]: true;
}

/** Asset Service 从内存字节签发的 Asset。 */
export interface BytesAssetRef {
  readonly kind: 'bytes-asset';
  readonly id: string;
  readonly [bytesAssetTypeBrand]: true;
}

/** 所有受管 Asset 引用。 */
export type AssetRef = SourceAssetRef | GeneratedAssetRef | BytesAssetRef;

/** 受管 Asset 支持的文件权限。 */
export type AssetMode = 0o644 | 0o755;

/** Bytes Asset 的稳定生成来源。 */
export interface GeneratedBytesOriginInput {
  readonly operation: string;
  readonly subjects?: readonly string[];
}

/** owner-scoped Asset 创建与受限读取服务。 */
export interface AssetService {
  /** 从已授权来源文件创建保留来源身份的 Asset。 */
  fromSource(source: SourceFileRef, options?: { readonly mode?: AssetMode }): Promise<SourceAssetRef>;
  /** 从复制后的内存字节创建带结构化来源的 Asset。 */
  fromBytes(input: { readonly bytes: Uint8Array | string; readonly mode?: AssetMode; readonly origin: GeneratedBytesOriginInput }): Promise<BytesAssetRef>;
  /** 在 owner grant 和读取上限内复制 Asset 字节。 */
  read(asset: AssetRef, options?: { readonly maxBytes?: number }): Promise<Uint8Array>;
}

/** Execution Host 的稳定进程结果。 */
export interface ExecutionResult {
  readonly status: 'exited' | 'signaled' | 'timed-out' | 'output-limit';
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly stdout: Uint8Array;
  readonly stderr: Uint8Array;
}

/** owner-scoped Node Execution Host 能力。 */
export interface ExecutionService {
  /** 在隔离 cwd、最小环境和固定资源上限内执行 Node entry。 */
  runNode(request: {
    readonly entry: GeneratedAssetRef;
    readonly args?: readonly string[];
    readonly stdin?: Uint8Array | string;
    readonly timeoutMs: number;
    readonly maxOutputBytes: number;
    readonly environment?: Readonly<Record<string, string>>;
  }): Promise<ExecutionResult>;
}
