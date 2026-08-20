import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import type {
  AssetMode,
  AssetRef,
  AssetService,
  BytesAssetRef,
  GeneratedAssetRef,
  GeneratedBytesOriginInput,
  SourceAssetRef,
  SourceFileRef,
} from '../contracts/services.js';
import type { AssetOrigin } from '../contracts/reports.js';
import type { CompileAssetOriginInput } from '../contracts/compiler.js';
import { BuildSessionScope } from '../lifecycle/session-scope.js';
import { compareCodePoints, safeRelativePath, validatePhysicalEntry } from '../security/path-policy.js';
import { SourceRegistry } from './sources.js';
import type { WorkDirectoryHandle } from './work-directories.js';
import { WorkDirectoryRegistry } from './work-directories.js';

/** Asset Registry 公开给后续 Package/Report 层的冻结元数据。 */
export interface AssetRecord {
  readonly id: string;
  readonly kind: AssetRef['kind'];
  readonly owner: string;
  readonly mode: AssetMode;
  readonly size: number;
  readonly sha256: string;
  readonly origin: AssetOrigin;
}

/** Distribution callback 期间新签发 Asset 的一次性授权范围。 */
export interface AssetIssuanceScope {
  readonly service: AssetService;
  /** @returns 当前 ref 是否由本 scope 新签发。 */
  readonly includes: (asset: AssetRef) => boolean;
  /** 关闭后拒绝 callback 泄漏的 service 继续签发或读取。 */
  readonly close: () => void;
}

/** Asset 物化前仍需保留的私有来源。 */
type AssetSource = {
  readonly type: 'bytes';
  readonly bytes: Uint8Array;
} | {
  readonly type: 'file';
  readonly file: string;
  readonly root: string;
};

/** AssetRef 对应的完整私有授权记录。 */
interface InternalAssetRecord extends AssetRecord {
  readonly session: object;
  readonly source: AssetSource;
}

/** Asset 读取操作的默认单次字节上限。 */
const DEFAULT_ASSET_READ_LIMIT = 16 * 1024 * 1024;

/** Asset 读取操作允许的 Core 固定最大上限。 */
const MAX_ASSET_READ_LIMIT = 64 * 1024 * 1024;

/** 稳定 operation、job、output 与 subject 共用的 ID 规则。 */
const STABLE_ORIGIN_ID = /^[a-z0-9]+(?:[-.:/][a-z0-9]+)*$/;

/**
 * 计算不可变 Asset 字节摘要。
 *
 * @param bytes 输入字节。
 * @returns SHA-256 十六进制摘要。
 */
function hashBytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * 读取并哈希一个已验证普通文件。
 *
 * @param file 文件绝对路径。
 * @returns 文件字节、长度和摘要。
 */
async function readAndHashFile(file: string): Promise<{ readonly bytes: Uint8Array; readonly size: number; readonly sha256: string }> {
  /** readFile 结果复制为精确 Uint8Array snapshot。 */
  const bytes = Uint8Array.from(await fs.readFile(file));
  return Object.freeze({ bytes, size: bytes.byteLength, sha256: hashBytes(bytes) });
}

/**
 * 验证 Asset 文件权限。
 *
 * @param value 调用方可选 mode。
 * @param fallback 未提供时使用的模式。
 * @returns 0644 或 0755。
 */
function assetMode(value: AssetMode | undefined, fallback: AssetMode): AssetMode {
  /** 未显式提供 mode 时使用来源或调用阶段决定的安全默认。 */
  const mode = value ?? fallback;
  if (mode !== 0o644 && mode !== 0o755)
    throw new Error('Asset mode must be 0644 or 0755.');
  return mode;
}

/**
 * 验证 Asset 读取上限。
 *
 * @param value 调用方请求值。
 * @returns Core 固定范围内的正整数。
 */
function assetReadLimit(value: number | undefined): number {
  /** 省略时使用固定默认，显式值仍不得扩大 Core 上限。 */
  const limit = value ?? DEFAULT_ASSET_READ_LIMIT;
  if (!Number.isSafeInteger(limit) || limit <= 0 || limit > MAX_ASSET_READ_LIMIT)
    throw new Error(`Asset read limit must be an integer between 1 and ${MAX_ASSET_READ_LIMIT}.`);
  return limit;
}

/**
 * 验证稳定来源文本不会承载路径、凭据或任意日志。
 *
 * @param value 待验证文本。
 * @param label 诊断字段名称。
 * @returns 原始稳定文本。
 */
function stableOriginId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !STABLE_ORIGIN_ID.test(value))
    throw new Error(`${label} must be a stable lowercase identifier.`);
  return value;
}

/**
 * 验证 Compiler module report 使用的安全逻辑来源引用。
 *
 * @param value project-relative、virtual 或 package identity。
 * @returns 不包含物理绝对路径的原始引用。
 */
function safeOriginReference(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0') || value.includes('\\'))
    throw new Error('Compile Asset input must be a safe logical source reference.');
  if (value.startsWith('package:')) {
    if (!/^package:(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+@[0-9A-Za-z.+-]+(?:\/[A-Za-z0-9._/-]+)?$/.test(value)
      || value.split('/').includes('..')) {
      throw new Error('Compile Asset package input is invalid.');
    }
    return value;
  }
  if (value.startsWith('virtual:')) {
    if (!/^virtual:[a-z0-9]+(?:[-.:/][a-z0-9]+)*$/.test(value))
      throw new Error('Compile Asset virtual input is invalid.');
    return value;
  }
  safeRelativePath(value);
  return value;
}

/** 与单次 BuildSession 绑定的 Source、Bytes 与 Generated Asset Registry。 */
export class AssetRegistry {
  /** 当前 BuildSession 的共享存活与身份边界。 */
  readonly #scope: BuildSessionScope;
  /** 用于校验 SourceFileRef 原始授权的 Source Registry。 */
  readonly #sources: SourceRegistry;
  /** 用于校验 Generated file workDir 授权的 Registry。 */
  readonly #workDirectories: WorkDirectoryRegistry;
  /** AssetRef 的对象身份授权记录。 */
  readonly #records = new WeakMap<object, InternalAssetRecord>();
  /** owner 闭包之外显式授予的 read/inherit 权限。 */
  readonly #grants = new WeakMap<object, Set<string>>();
  /** owner 内单调递增且不受其他 owner 并行完成顺序影响的 ref 序号。 */
  readonly #ownerSequences = new Map<string, number>();

  /**
   * 创建当前 BuildSession 唯一 Asset Registry。
   *
   * @param scope 当前 BuildSession capability scope。
   * @param sources 当前 Session Source Registry。
   * @param workDirectories 当前 Session owner workDir Registry。
   */
  constructor(scope: BuildSessionScope, sources: SourceRegistry, workDirectories: WorkDirectoryRegistry) {
    this.#scope = scope;
    this.#sources = sources;
    this.#workDirectories = workDirectories;
  }

  /**
   * 为 owner 创建闭包绑定的 SDK AssetService。
   *
   * @param owner 当前 Platform、Extension 或 Framework Resource owner。
   * @returns 不允许调用方自报 owner 的服务。
   */
  service(owner: string): AssetService {
    /** 显式接口注解为对象方法提供 SDK 参数的上下文类型。 */
    const service: AssetService = {
      /** 从当前 owner 的 SourceFileRef 创建来源 Asset。 */
      fromSource: (source, options) => this.issueSource(owner, source, options),
      /** 从复制后的内存字节创建生成 Asset。 */
      fromBytes: input => this.issueBytes(owner, input),
      /** 按 owner 或显式 grant 读取 Asset snapshot。 */
      read: (asset, options) => this.read(owner, asset, options),
    };
    return Object.freeze(service);
  }

  /**
   * 为单次 Distribution callback 创建可撤销的 Asset Service。
   *
   * @param owner 当前 Platform owner。
   * @returns 记录本次新签发 ref 且 callback 后可关闭的 scope。
   */
  issuanceScope(owner: string): AssetIssuanceScope {
    this.#scope.assertActive();
    if (typeof owner !== 'string' || owner.length === 0)
      throw new Error('Asset issuance owner must be a non-empty string.');
    /** issued 只记录通过本 scope 返回给 callback 的新 ref identity。 */
    const issued = new WeakSet<object>();
    /** active 关闭 callback 后撤销泄漏 service 的全部方法。 */
    let active = true;
    /** 每个方法入口统一复核 scope 仍处于授权期。 */
    const assertActive = (): void => {
      if (!active)
        throw new Error('Asset issuance scope is no longer active.');
      this.#scope.assertActive();
    };
    /** 新签发 ref 在返回 Integration 前登记到当前 scope。 */
    const remember = <T extends AssetRef>(asset: T): T => {
      issued.add(asset);
      return asset;
    };
    /** service 保持公开 AssetService 形态但带可撤销 closure。 */
    const service: AssetService = {
      /** scope 内 SourceAsset 签发后记录 identity。 */
      fromSource: async (source, options) => {
        assertActive();
        return remember(await this.issueSource(owner, source, options));
      },
      /** scope 内 BytesAsset 签发后记录 identity。 */
      fromBytes: async (input) => {
        assertActive();
        return remember(await this.issueBytes(owner, input));
      },
      /** callback 读取也受 scope 生命周期约束。 */
      read: async (asset, options) => {
        assertActive();
        return this.read(owner, asset, options);
      },
    };
    return Object.freeze({
      service: Object.freeze(service),
      /** includes 只能查询对象 identity，不暴露签发集合。 */
      includes: (asset: AssetRef) => issued.has(asset),
      /** close 幂等撤销 callback 能力。 */
      close: () => { active = false; },
    });
  }

  /**
   * 生成本 Session 内唯一但不包含路径语义的 Asset ID。
   *
   * @param owner Asset owner。
   * @param kind Asset 来源类别。
   * @returns 只用于安全逻辑引用的稳定形状 ID。
   */
  #nextId(owner: string, kind: AssetRef['kind']): string {
    /** owner-local sequence 防止并发 Integration 通过自身 ref ID 观察彼此调度。 */
    const sequence = (this.#ownerSequences.get(owner) ?? 0) + 1;
    this.#ownerSequences.set(owner, sequence);
    /** hash 避免把任意 owner 文本直接暴露为 ref ID。 */
    const ownerHash = createHash('sha256').update(owner).digest('hex').slice(0, 12);
    return `${kind}:${ownerHash}:${sequence}`;
  }

  /**
   * 为内部记录签发对应的冻结 AssetRef。
   *
   * @param input 不含 Session 与 ref ID 的记录输入。
   * @returns 对象身份进入 WeakMap 的 SDK ref。
   */
  #issue(input: Omit<InternalAssetRecord, 'id' | 'session'>): AssetRef {
    this.#scope.assertActive();
    /** 每个 ref identity 都使用当前 Session 内部唯一 ID。 */
    const id = this.#nextId(input.owner, input.kind);
    /** 公开对象只包含安全 kind/id；绝对路径与 bytes 留在 WeakMap。 */
    const reference = Object.freeze({ kind: input.kind, id }) as AssetRef;
    /** origin 与外层元数据均已冻结，私有 source 不通过公开对象可达。 */
    const record = Object.freeze({ ...input, id, session: this.#scope.token });
    this.#records.set(reference, record);
    return reference;
  }

  /**
   * 从当前 owner 的 SourceFileRef 创建 SourceAssetRef。
   *
   * @param owner 当前 Context owner。
   * @param source 当前 owner 的精确来源文件。
   * @param options 可选目标 mode。
   * @returns 保留来源 origin 的 AssetRef。
   */
  async issueSource(
    owner: string,
    source: SourceFileRef,
    options: { readonly mode?: AssetMode } = {},
  ): Promise<SourceAssetRef> {
    this.#scope.assertActive();
    /** SourceRegistry WeakMap authorization 同时阻止伪造和跨 owner ref。 */
    const sourceRecord = this.#sources.authorizeFile(owner, source);
    /** 签发前重新验证来源文件类型与 realpath。 */
    const stat = await validatePhysicalEntry(sourceRecord.root, sourceRecord.physicalPath, 'file');
    /** 签发时记录精确字节摘要用于 TOCTOU 检查。 */
    const content = await readAndHashFile(sourceRecord.physicalPath);
    if (content.size !== sourceRecord.size || content.sha256 !== sourceRecord.sha256)
      throw new Error(`Source file changed after its reference was issued: "${sourceRecord.reportPath}".`);
    /** Source origin 只包含安全 Resource owner 和工程相对路径。 */
    const origin = Object.freeze({ type: 'source' as const, resource: owner, path: sourceRecord.reportPath });
    return this.#issue({
      kind: 'source-asset',
      owner,
      mode: assetMode(options.mode, stat.mode & 0o111 ? 0o755 : 0o644),
      size: content.size,
      sha256: content.sha256,
      origin,
      source: Object.freeze({ type: 'file', file: sourceRecord.physicalPath, root: sourceRecord.root }),
    }) as SourceAssetRef;
  }

  /**
   * 从复制后的内存字节创建 BytesAssetRef。
   *
   * @param owner 当前 Context owner。
   * @param input 字节、mode 与结构化来源。
   * @returns 不受调用方后续 mutation 影响的 AssetRef。
   */
  async issueBytes(owner: string, input: {
    readonly bytes: Uint8Array | string;
    readonly mode?: AssetMode;
    readonly origin: GeneratedBytesOriginInput;
  }): Promise<BytesAssetRef> {
    this.#scope.assertActive();
    if (typeof input !== 'object' || input === null)
      throw new Error('Bytes Asset input must be an object.');
    /** 字符串按 UTF-8 编码，Uint8Array 必须复制底层存储。 */
    const bytes = typeof input.bytes === 'string' ? new TextEncoder().encode(input.bytes) : Uint8Array.from(input.bytes);
    /** subjects 是稳定标识集合，复制、去重并按 code point 排序。 */
    const subjects = input.origin.subjects?.map(subject => stableOriginId(subject, 'Generated Asset subject')).sort(compareCodePoints);
    if (subjects !== undefined && new Set(subjects).size !== subjects.length)
      throw new Error('Generated Asset subjects must not contain duplicates.');
    /** owner 由闭包覆盖，调用方只能填写 operation/subjects。 */
    const origin = Object.freeze({
      type: 'generated' as const,
      owner,
      operation: stableOriginId(input.origin.operation, 'Generated Asset operation'),
      ...(subjects === undefined ? {} : { subjects: Object.freeze(subjects) }),
    });
    return this.#issue({
      kind: 'bytes-asset',
      owner,
      mode: assetMode(input.mode, 0o644),
      size: bytes.byteLength,
      sha256: hashBytes(bytes),
      origin,
      source: Object.freeze({ type: 'bytes', bytes }),
    }) as BytesAssetRef;
  }

  /**
   * 由 Compiler Host 从 owner workDir 普通文件签发 GeneratedAssetRef。
   *
   * @param owner Compiler Context 固定 owner。
   * @param workDirectory 当前 owner 的 workDir 句柄。
   * @param relativeFile workDir-relative 输出文件。
   * @param mode 输出权限。
   * @param origin 编译 job/output/input 来源。
   * @returns 带 TOCTOU 文件来源的生成 Asset。
   */
  async issueGenerated(
    owner: string,
    workDirectory: WorkDirectoryHandle,
    relativeFile: string,
    mode: AssetMode,
    origin: CompileAssetOriginInput,
  ): Promise<GeneratedAssetRef> {
    this.#scope.assertActive();
    /** WorkDirectoryRegistry 验证对象 identity、owner、Session、symlink 与普通文件类型。 */
    const generated = await this.#workDirectories.generatedFile(owner, workDirectory, relativeFile);
    /** 签发时读取精确生成文件快照用于摘要和 TOCTOU 基线。 */
    const content = await readAndHashFile(generated.file);
    /** 编译来源 inputs 使用安全 path/package/virtual identity 且稳定排序。 */
    const inputs = origin.inputs.map(safeOriginReference).sort(compareCodePoints);
    if (new Set(inputs).size !== inputs.length)
      throw new Error('Compile Asset inputs must not contain duplicates.');
    /** profile/kind 是 Execution/Report 依赖的结构化 compile provenance。 */
    if (origin.profile !== 'portable-node' && origin.profile !== 'managed-rolldown')
      throw new Error('Compile Asset profile is invalid.');
    if (origin.kind !== 'chunk' && origin.kind !== 'asset' && origin.kind !== 'licenses')
      throw new Error('Compile Asset kind is invalid.');
    /** owner 同样由 Host 闭包覆盖。 */
    const assetOrigin = Object.freeze({
      type: 'compile' as const,
      owner,
      job: stableOriginId(origin.job, 'Compile job'),
      output: stableOriginId(origin.output, 'Compile output'),
      profile: origin.profile,
      kind: origin.kind,
      inputs: Object.freeze(inputs),
    });
    return this.#issue({
      kind: 'generated-asset',
      owner,
      mode: assetMode(mode, 0o644),
      size: content.size,
      sha256: content.sha256,
      origin: assetOrigin,
      source: Object.freeze({ type: 'file', file: generated.file, root: generated.root }),
    }) as GeneratedAssetRef;
  }

  /**
   * 显式授予另一个 owner 读取或继承一个既有 AssetRef。
   *
   * @param granter 当前 ref owner。
   * @param grantee 获得权限的 Platform 或 Framework owner。
   * @param asset 当前 Session 原始 ref 对象。
   */
  grant(granter: string, grantee: string, asset: AssetRef): void {
    this.#scope.assertActive();
    if (typeof grantee !== 'string' || grantee.length === 0)
      throw new Error('Asset grantee must be a non-empty owner.');
    if (typeof asset !== 'object' || asset === null)
      throw new Error('Asset reference is not authorized for this BuildSession.');
    /** grant 只接受原始 ref owner，已有 grantee 不能继续转授权。 */
    const record = this.#records.get(asset);
    if (record === undefined || record.session !== this.#scope.token || record.owner !== granter)
      throw new Error('Only the Asset owner can grant access.');
    /** grant 与原 ref 对象 identity 绑定，复制等形对象无法继承。 */
    const grants = this.#grants.get(asset) ?? new Set<string>();
    grants.add(grantee);
    this.#grants.set(asset, grants);
  }

  /**
   * 授权并返回当前 Session 的内部 Asset 记录。
   *
   * @param owner 当前 Context owner。
   * @param asset 待使用 AssetRef。
   * @returns 当前 Registry 内部记录。
   */
  #authorize(owner: string, asset: unknown): InternalAssetRecord {
    this.#scope.assertActive();
    if (typeof asset !== 'object' || asset === null)
      throw new Error('Asset reference is not authorized for this BuildSession.');
    /** WeakMap 对象身份是运行时授权唯一依据。 */
    const record = this.#records.get(asset);
    if (record === undefined || record.session !== this.#scope.token
      || (record.owner !== owner && !this.#grants.get(asset)?.has(owner))) {
      throw new Error('Asset reference is not authorized for this owner and BuildSession.');
    }
    return record;
  }

  /**
   * 读取一个 owner 可访问的 Asset snapshot。
   *
   * @param owner 当前 Context owner。
   * @param asset 当前 Session 原始 AssetRef。
   * @param options 可选读取上限。
   * @returns 复制且不共享内部存储的字节。
   */
  async read(owner: string, asset: AssetRef, options: { readonly maxBytes?: number } = {}): Promise<Uint8Array> {
    /** 当前 owner 必须是 issuer 或显式 grantee。 */
    const record = this.#authorize(owner, asset);
    /** 单次读取始终受 Core 最大值约束。 */
    const limit = assetReadLimit(options.maxBytes);
    if (record.size > limit)
      throw new Error(`Asset "${record.id}" exceeds the requested read limit.`);
    if (record.source.type === 'bytes')
      return Uint8Array.from(record.source.bytes);
    /** 文件型 Asset 每次读取前执行 TOCTOU preflight。 */
    const bytes = await this.#verifiedFileBytes(record);
    return Uint8Array.from(bytes);
  }

  /**
   * 在 candidate/stage 物化前复核 Asset 并返回字节。
   *
   * @param owner 当前被授权物化的 owner。
   * @param asset 当前 Session 原始 AssetRef。
   * @returns 与签发摘要一致的精确字节。
   */
  async materializationBytes(owner: string, asset: AssetRef): Promise<Uint8Array> {
    /** Materializer 也必须持有当前 Session 的明确 grant。 */
    const record = this.#authorize(owner, asset);
    if (record.source.type === 'bytes')
      return Uint8Array.from(record.source.bytes);
    return this.#verifiedFileBytes(record);
  }

  /**
   * 复核文件类型、realpath、size 与 hash。
   *
   * @param record 文件型 Asset 内部记录。
   * @returns 当前精确字节。
   */
  async #verifiedFileBytes(record: InternalAssetRecord): Promise<Uint8Array> {
    if (record.source.type !== 'file')
      throw new Error('Internal Asset source invariant failed.');
    await validatePhysicalEntry(record.source.root, record.source.file, 'file');
    /** 当前文件内容必须仍与签发 snapshot 摘要相同。 */
    const current = await readAndHashFile(record.source.file);
    if (current.size !== record.size || current.sha256 !== record.sha256)
      throw new Error(`Asset source changed after it was issued: ${record.id}.`);
    return current.bytes;
  }

  /**
   * 返回不包含私有来源的 Asset 元数据。
   *
   * @param owner 当前具有访问 grant 的 owner。
   * @param asset 当前 Session 原始 AssetRef。
   * @returns 可进入 Package snapshot/report 的冻结记录。
   */
  describe(owner: string, asset: AssetRef): AssetRecord {
    /** 描述操作不能旁路与读取相同的授权边界。 */
    const record = this.#authorize(owner, asset);
    return Object.freeze({
      id: record.id,
      kind: record.kind,
      owner: record.owner,
      mode: record.mode,
      size: record.size,
      sha256: record.sha256,
      origin: record.origin,
    });
  }
}
