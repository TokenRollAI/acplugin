import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type {
  SourceDirectoryRef,
  SourceEntry,
  SourceFileRef,
  SourceService,
} from '../contracts/services.js';
import { BuildSessionScope } from './session-scope.js';
import {
  compareCodePoints,
  isInsidePath,
  projectReportPath,
  safeRelativePath,
  SourcePathCollisionRegistry,
  validatePhysicalEntry,
} from '../security/path-policy.js';

/** SourceRef 对应的内部对象身份授权记录。 */
interface SourceRecord {
  readonly owner: string;
  readonly type: 'file' | 'directory';
  readonly root: string;
  readonly physicalPath: string;
  readonly reportPath: string;
  readonly session: object;
  readonly size?: number;
  readonly sha256?: string;
}

/** 作者源码边界使用的默认单次读取上限。 */
const DEFAULT_SOURCE_READ_LIMIT = 16 * 1024 * 1024;

/** 作者源码边界允许调用方请求的最大单次读取上限。 */
const MAX_SOURCE_READ_LIMIT = 64 * 1024 * 1024;

/**
 * 流式计算来源文件的大小和 SHA-256。
 *
 * @param file 已通过普通文件边界验证的绝对路径。
 * @returns 签发或重验证使用的内容指纹。
 */
async function sourceFingerprint(file: string): Promise<{ readonly size: number; readonly sha256: string }> {
  /** 增量哈希避免 SourceRef 签发时把任意大文件整体载入内存。 */
  const hash = createHash('sha256');
  /** 文件流累计读取的精确字节数。 */
  let size = 0;
  await new Promise<void>((resolve, reject) => {
    /** 每次调用使用新文件流，错误不能被静默降级为部分摘要。 */
    const stream = createReadStream(file);
    stream.on('data', (chunk) => {
      size += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length;
      hash.update(chunk);
    });
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  return Object.freeze({ size, sha256: hash.digest('hex') });
}

/**
 * 校验单次读取上限。
 *
 * @param requested 调用方可选请求值。
 * @returns 位于 Core 固定上限内的正整数。
 */
function readLimit(requested: number | undefined): number {
  /** 省略时使用固定默认，显式值仍不得扩大 Core 上限。 */
  const value = requested ?? DEFAULT_SOURCE_READ_LIMIT;
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_SOURCE_READ_LIMIT)
    throw new Error(`Source read limit must be an integer between 1 and ${MAX_SOURCE_READ_LIMIT}.`);
  return value;
}

/** SourceRef 使用 BuildSession WeakMap identity 实现的私有 Registry。 */
export class SourceRegistry {
  /** 当前 BuildSession 的共享存活和身份边界。 */
  readonly #scope: BuildSessionScope;
  /** 所有安全报告路径的解析根。 */
  readonly #projectRoot: string;
  /** Directory/File Ref 的不可伪造对象身份记录。 */
  readonly #records = new WeakMap<object, SourceRecord>();
  /** 已签发来源的 exact/case/NFC 冲突索引。 */
  readonly #collisions = new SourcePathCollisionRegistry();

  /**
   * 创建当前 BuildSession 唯一的 Source Registry。
   *
   * @param scope 当前 BuildSession capability scope。
   * @param projectRoot 工程绝对根目录。
   */
  constructor(scope: BuildSessionScope, projectRoot: string) {
    this.#scope = scope;
    this.#projectRoot = path.resolve(projectRoot);
  }

  /**
   * 登记一个 Author Source root 并为 owner 签发 DirectoryRef。
   *
   * @param owner 由 Kernel 固定的 Resource owner。
   * @param physicalRoot 已配置且位于工程内的绝对 root。
   * @returns 不暴露物理绝对路径的目录能力。
   */
  async issueRoot(owner: string, physicalRoot: string): Promise<SourceDirectoryRef> {
    this.#scope.assertActive();
    if (typeof owner !== 'string' || owner.length === 0)
      throw new Error('Source owner must be a non-empty string.');
    /** 所有后续授权都以真实、无符号链接的来源根为界。 */
    const root = path.resolve(physicalRoot);
    if (!isInsidePath(this.#projectRoot, root))
      throw new Error('Author source root must be inside the project root.');
    await validatePhysicalEntry(this.#projectRoot, root, 'directory');
    /** root 本身也必须通过 project realpath 边界。 */
    const projectReal = await fs.realpath(this.#projectRoot);
    /** 来源根真实路径用于复核系统级祖先 symlink 后的边界。 */
    const rootReal = await fs.realpath(root);
    if (!isInsidePath(projectReal, rootReal))
      throw new Error('Author source root realpath escapes the project root.');
    return this.#issue(owner, 'directory', root, root, projectReportPath(this.#projectRoot, root)) as SourceDirectoryRef;
  }

  /**
   * 为一个已验证来源签发对象身份 ref。
   *
   * @param owner 来源 owner。
   * @param type 最终来源类型。
   * @param root 授权物理根。
   * @param physicalPath 来源绝对路径。
   * @param reportPath 安全工程相对路径。
   * @returns 冻结且不包含绝对路径的 ref。
   */
  #issue(
    owner: string,
    type: 'file' | 'directory',
    root: string,
    physicalPath: string,
    reportPath: string,
    fingerprint?: { readonly size: number; readonly sha256: string },
  ): SourceDirectoryRef | SourceFileRef {
    this.#reserveCollision(reportPath, physicalPath);
    /** 公开 ref 只保留 kind 与安全报告路径；类型品牌在编译期存在。 */
    const reference = Object.freeze({ kind: type === 'file' ? 'source-file' as const : 'source-directory' as const, path: reportPath });
    this.#records.set(reference, Object.freeze({
      owner,
      type,
      root,
      physicalPath,
      reportPath,
      session: this.#scope.token,
      ...(fingerprint === undefined ? {} : fingerprint),
    }));
    return reference as SourceDirectoryRef | SourceFileRef;
  }

  /**
   * 登记来源路径冲突，允许同一物理路径被重复签发。
   *
   * @param reportPath 工程相对路径。
   * @param physicalPath 来源绝对路径。
   */
  #reserveCollision(reportPath: string, physicalPath: string): void {
    this.#collisions.reserve(reportPath, physicalPath);
  }

  /**
   * 解析并验证一个当前 owner 持有的 SourceRef。
   *
   * @param owner 当前 Context owner。
   * @param reference 未知或 SDK ref 值。
   * @param type 期望类型。
   * @returns 当前 Registry 内部记录。
   */
  #authorize(owner: string, reference: unknown, type: SourceRecord['type']): SourceRecord {
    this.#scope.assertActive();
    if (typeof reference !== 'object' || reference === null)
      throw new Error('Source reference is not authorized for this BuildSession.');
    /** WeakMap lookup 是运行时授权的唯一依据。 */
    const record = this.#records.get(reference);
    if (record === undefined || record.session !== this.#scope.token || record.owner !== owner || record.type !== type)
      throw new Error('Source reference is not authorized for this owner and BuildSession.');
    return record;
  }

  /**
   * 检查文件 ref 并返回 Registry 内部安全记录。
   *
   * @param owner 当前 Context owner。
   * @param file 待检查文件 ref。
   * @returns 已验证文件内部记录。
   */
  authorizeFile(owner: string, file: SourceFileRef): Readonly<SourceRecord> {
    return this.#authorize(owner, file, 'file');
  }

  /**
   * 检查目录 ref 并返回 Registry 内部安全记录。
   *
   * @param owner 当前 Context owner。
   * @param directory 待检查目录 ref。
   * @returns 已验证目录内部记录。
   */
  authorizeDirectory(owner: string, directory: SourceDirectoryRef): Readonly<SourceRecord> {
    return this.#authorize(owner, directory, 'directory');
  }

  /**
   * 在 Compiler/Materializer 消费前复核 FileRef 内容指纹。
   *
   * @param owner 当前 Core Host owner。
   * @param file 待复核文件 ref。
   * @returns 指纹和物理边界均未变化的内部记录。
   */
  async validatedFile(owner: string, file: SourceFileRef): Promise<Readonly<SourceRecord>> {
    /** FileRef 对应的已授权内部记录。 */
    const record = this.#authorize(owner, file, 'file');
    await validatePhysicalEntry(record.root, record.physicalPath, 'file');
    /** 重新流式计算指纹，不受 SDK 单次读取上限影响。 */
    const fingerprint = await sourceFingerprint(record.physicalPath);
    if (record.size !== fingerprint.size || record.sha256 !== fingerprint.sha256)
      throw new Error(`Source file changed after its reference was issued: "${record.reportPath}".`);
    return record;
  }

  /**
   * 在 Compiler 读取前递归拒绝授权作者树中的 symlink 和特殊文件。
   *
   * @param owner 当前 Core Host owner。
   * @param directory 待复核目录 ref。
   * @returns 完整树通过物理边界检查时完成。
   */
  async validateTree(owner: string, directory: SourceDirectoryRef): Promise<void> {
    /** DirectoryRef 对应的已授权内部记录。 */
    const record = this.#authorize(owner, directory, 'directory');
    await this.#validateRecordTree(record);
  }

  /**
   * 在 Compiler 消费文件入口前复核其完整授权根。
   *
   * @param owner 当前 Core Host owner。
   * @param file 已签发精确文件 ref。
   * @returns 授权根完整通过 symlink/特殊文件检查时完成。
   */
  async validateFileTree(owner: string, file: SourceFileRef): Promise<void> {
    /** FileRef 授权根对应的内部记录。 */
    const record = this.#authorize(owner, file, 'file');
    await this.#validateRecordTree(record);
  }

  /**
   * 递归检查一个已授权 Source 记录的整个物理根。
   *
   * @param record 已通过 owner/Session/ref identity 授权的记录。
   */
  async #validateRecordTree(record: SourceRecord): Promise<void> {
    /** 递归枚举只做物理校验，不签发新的可观察 ref。 */
    const visit = async (directoryPath: string): Promise<void> => {
      /** 当前目录中按 code point 排序的物理目录项。 */
      const entries = (await fs.readdir(directoryPath, { withFileTypes: true }))
        .sort((left, right) => compareCodePoints(left.name, right.name));
      for (const entry of entries) {
        /** 当前目录项的物理绝对路径。 */
        const candidate = path.join(directoryPath, entry.name);
        /** 当前目录项的安全工程相对路径。 */
        const reportPath = projectReportPath(this.#projectRoot, candidate);
        /** 完整树验证同时建立 case/NFC 冲突索引，避免 Provider 枚举时才失败。 */
        this.#reserveCollision(reportPath, candidate);
        if (entry.isSymbolicLink())
          throw new Error(`Author source trees must not contain symbolic links at "${reportPath}".`);
        if (!entry.isFile() && !entry.isDirectory())
          throw new Error(`Author source trees must contain only regular files and directories at "${reportPath}".`);
        await validatePhysicalEntry(record.root, candidate, entry.isFile() ? 'file' : 'directory');
        if (entry.isDirectory())
          await visit(candidate);
      }
    };
    await validatePhysicalEntry(record.root, record.root, 'directory');
    await visit(record.root);
  }

  /**
   * 为 owner 创建闭包绑定的 SDK SourceService。
   *
   * @param owner 当前 Extension 或 Framework Resource owner。
   * @returns 不允许调用方自报 owner 的受限服务。
   */
  service(owner: string): SourceService {
    /** 显式接口注解为对象方法提供 SDK 参数的上下文类型。 */
    const service: SourceService = {
      /** 枚举一个已授权目录。 */
      list: (directory, options) => this.#list(owner, directory, options),
      /** 为目录后代签发精确文件 ref。 */
      file: (directory, relativePath) => this.#file(owner, directory, relativePath),
      /** 为目录后代签发精确目录 ref。 */
      directory: (directory, relativePath) => this.#directory(owner, directory, relativePath),
      /** 在固定上限内复制来源文件字节。 */
      read: (file, options) => this.#read(owner, file, options),
      /** 在固定上限内以严格 UTF-8 解码来源文件。 */
      readText: (file, options) => this.#readText(owner, file, options),
    };
    return Object.freeze(service);
  }

  /**
   * 解析安全目录后代路径。
   *
   * @param record 已授权父目录记录。
   * @param relativePath 调用方提交的 POSIX 相对路径。
   * @returns 物理路径与安全报告路径。
   */
  #descendant(record: SourceRecord, relativePath: string): { readonly physicalPath: string; readonly reportPath: string } {
    /** 先按公开语法规则拒绝模糊路径。 */
    const safe = safeRelativePath(relativePath);
    /** 逐 segment 使用宿主 path API 建立物理候选。 */
    const physicalPath = path.join(record.physicalPath, ...safe.split('/'));
    if (!isInsidePath(record.root, physicalPath))
      throw new Error('Source path escapes its authorized root.');
    return Object.freeze({ physicalPath, reportPath: projectReportPath(this.#projectRoot, physicalPath) });
  }

  /**
   * 签发一个目录后代文件 ref。
   *
   * @param owner 当前 service owner。
   * @param directory 已授权父目录。
   * @param relativePath 相对父目录的安全路径。
   * @returns 当前 Session 的 SourceFileRef。
   */
  async #file(owner: string, directory: SourceDirectoryRef, relativePath: string): Promise<SourceFileRef> {
    /** 父目录必须是当前 owner 在本 Session 收到的原始 ref。 */
    const record = this.#authorize(owner, directory, 'directory');
    /** 后代路径解析不会暴露到公开结果。 */
    const descendant = this.#descendant(record, relativePath);
    await validatePhysicalEntry(record.root, descendant.physicalPath, 'file');
    /** FileRef 签发时固定内容指纹，后续读取和 Asset 转换必须一致。 */
    const fingerprint = await sourceFingerprint(descendant.physicalPath);
    return this.#issue(owner, 'file', record.root, descendant.physicalPath, descendant.reportPath, fingerprint) as SourceFileRef;
  }

  /**
   * 签发一个目录后代目录 ref。
   *
   * @param owner 当前 service owner。
   * @param directory 已授权父目录。
   * @param relativePath 相对父目录的安全路径。
   * @returns 当前 Session 的 SourceDirectoryRef。
   */
  async #directory(owner: string, directory: SourceDirectoryRef, relativePath: string): Promise<SourceDirectoryRef> {
    /** 父目录必须是当前 owner 在本 Session 收到的原始 ref。 */
    const record = this.#authorize(owner, directory, 'directory');
    /** 后代路径解析不会暴露到公开结果。 */
    const descendant = this.#descendant(record, relativePath);
    await validatePhysicalEntry(record.root, descendant.physicalPath, 'directory');
    return this.#issue(owner, 'directory', record.root, descendant.physicalPath, descendant.reportPath) as SourceDirectoryRef;
  }

  /**
   * 稳定枚举目录中的普通文件和目录。
   *
   * @param owner 当前 service owner。
   * @param directory 已授权目录。
   * @param options 是否递归枚举全部后代。
   * @returns 按 Unicode code point 路径排序的 SourceEntry。
   */
  async #list(
    owner: string,
    directory: SourceDirectoryRef,
    options: { readonly recursive?: boolean } | undefined,
  ): Promise<readonly SourceEntry[]> {
    /** 枚举只能从当前 owner 的原始 DirectoryRef 开始。 */
    const record = this.#authorize(owner, directory, 'directory');
    if (options !== undefined && (typeof options !== 'object' || options === null || Array.isArray(options)
      || Object.keys(options).some(field => field !== 'recursive') || (options.recursive !== undefined && typeof options.recursive !== 'boolean'))) {
      throw new Error('Source list options are invalid.');
    }
    await validatePhysicalEntry(record.root, record.physicalPath, 'directory');
    /** 当前枚举累计的后代 entry。 */
    const results: SourceEntry[] = [];
    /**
     * 递归枚举一个目录并签发其直接子项。
     *
     * @param current 当前物理目录。
     */
    const visit = async (current: string): Promise<void> => {
      /** readdir 结果先按 code point name 排序，再由最终完整 path 排序。 */
      const entries = (await fs.readdir(current, { withFileTypes: true })).sort((left, right) => compareCodePoints(left.name, right.name));
      for (const entry of entries) {
        /** 当前子项的绝对物理路径。 */
        const physicalPath = path.join(current, entry.name);
        /** 当前子项的安全工程相对报告路径。 */
        const reportPath = projectReportPath(this.#projectRoot, physicalPath);
        if (entry.isSymbolicLink())
          throw new Error(`Author source trees must not contain symbolic links at "${reportPath}".`);
        if (!entry.isFile() && !entry.isDirectory())
          throw new Error(`Author source trees must contain only regular files and directories at "${reportPath}".`);
        await validatePhysicalEntry(record.root, physicalPath, entry.isFile() ? 'file' : 'directory');
        if (entry.isFile()) {
          /** 文件 entry 包含当前 owner 的精确 file ref。 */
          const file = this.#issue(owner, 'file', record.root, physicalPath, reportPath, await sourceFingerprint(physicalPath)) as SourceFileRef;
          results.push(Object.freeze({ type: 'file', name: entry.name, path: reportPath, file }));
        } else {
          /** 目录 entry 包含当前 owner 的精确 directory ref。 */
          const child = this.#issue(owner, 'directory', record.root, physicalPath, reportPath) as SourceDirectoryRef;
          results.push(Object.freeze({ type: 'directory', name: entry.name, path: reportPath, directory: child }));
          if (options?.recursive === true)
            await visit(physicalPath);
        }
      }
    };
    await visit(record.physicalPath);
    return Object.freeze(results.sort((left, right) => compareCodePoints(left.path, right.path)));
  }

  /**
   * 复制一个已授权普通来源文件。
   *
   * @param owner 当前 service owner。
   * @param file 已授权文件 ref。
   * @param options 可选读取上限。
   * @returns 不与文件系统共享的 Uint8Array 副本。
   */
  async #read(
    owner: string,
    file: SourceFileRef,
    options: { readonly maxBytes?: number } | undefined,
  ): Promise<Uint8Array> {
    /** 读取只能使用当前 owner 的原始 FileRef。 */
    const record = this.#authorize(owner, file, 'file');
    /** 单次读取始终受 Core 最大值约束。 */
    const limit = readLimit(options?.maxBytes);
    /** lstat/realpath 在每次读取前重新检查，阻断签发后的替换。 */
    const stat = await validatePhysicalEntry(record.root, record.physicalPath, 'file');
    if (stat.size > limit)
      throw new Error(`Source file "${record.reportPath}" exceeds the requested read limit.`);
    /** readFile 的 Buffer 再复制为不共享底层存储的 Uint8Array。 */
    const bytes = await fs.readFile(record.physicalPath);
    if (bytes.byteLength > limit)
      throw new Error(`Source file "${record.reportPath}" exceeds the requested read limit.`);
    /** 签发后的普通内容修改也必须失败，不能只检查文件类型。 */
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    if (record.size !== bytes.byteLength || record.sha256 !== sha256)
      throw new Error(`Source file changed after its reference was issued: "${record.reportPath}".`);
    return Uint8Array.from(bytes);
  }

  /**
   * 使用致命 UTF-8 解码读取来源文本。
   *
   * @param owner 当前 service owner。
   * @param file 已授权文件 ref。
   * @param options 可选读取上限。
   * @returns 精确 UTF-8 文本。
   */
  async #readText(
    owner: string,
    file: SourceFileRef,
    options: { readonly maxBytes?: number } | undefined,
  ): Promise<string> {
    /** fatal 解码确保无效作者文本不被静默替换为 U+FFFD。 */
    return new TextDecoder('utf-8', { fatal: true }).decode(await this.#read(owner, file, options));
  }
}
