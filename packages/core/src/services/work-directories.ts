import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { BuildSessionScope } from './session-scope.js';
import { isInsidePath, safeRelativePath, validatePhysicalEntry } from '../security/path-policy.js';

/** WorkDirectoryRegistry 私有的不可伪造目录句柄。 */
export interface WorkDirectoryHandle {
  readonly kind: 'work-directory';
}

/** Work directory 句柄对应的内部授权记录。 */
interface WorkDirectoryRecord {
  readonly owner: string;
  readonly directory: string;
  readonly session: object;
}

/** Core 为每个 owner 管理唯一临时工作目录的私有 Registry。 */
export class WorkDirectoryRegistry {
  /** 当前 BuildSession 的共享存活与身份边界。 */
  readonly #scope: BuildSessionScope;
  /** 所有 owner workDir 的唯一物理父目录。 */
  readonly #root: string;
  /** 已签发句柄的对象身份记录。 */
  readonly #records = new WeakMap<WorkDirectoryHandle, WorkDirectoryRecord>();
  /** 每个 owner 恰好一个工作目录。 */
  readonly #owners = new Map<string, WorkDirectoryHandle>();

  /**
   * 创建一个只属于当前 BuildSession 的 WorkDir Registry。
   *
   * @param scope 当前 BuildSession capability scope。
   * @param root Core 已创建的临时根目录。
   */
  constructor(scope: BuildSessionScope, root: string) {
    this.#scope = scope;
    this.#root = path.resolve(root);
  }

  /**
   * 为 owner 创建或返回其唯一工作目录句柄。
   *
   * @param owner 由 Kernel 固定的稳定 owner。
   * @returns 不暴露物理路径的私有句柄。
   */
  async directory(owner: string): Promise<WorkDirectoryHandle> {
    this.#scope.assertActive();
    if (typeof owner !== 'string' || owner.length === 0)
      throw new Error('Work directory owner must be a non-empty string.');
    /** 同一 owner 重复请求必须观察相同授权身份。 */
    const existing = this.#owners.get(owner);
    if (existing !== undefined)
      return existing;
    await fs.mkdir(this.#root, { recursive: true, mode: 0o700 });
    /** owner hash 避免把任意 owner 文本直接解释为路径。 */
    const directory = path.join(this.#root, createHash('sha256').update(owner).digest('hex'));
    await fs.mkdir(directory, { recursive: false, mode: 0o700 });
    /** 公开句柄只有无路径语义的 kind。 */
    const handle = Object.freeze({ kind: 'work-directory' as const });
    this.#records.set(handle, Object.freeze({ owner, directory, session: this.#scope.token }));
    this.#owners.set(owner, handle);
    return handle;
  }

  /**
   * 解析 owner workDir 内的 Core 私有相对路径。
   *
   * @param owner 当前 Context 绑定的 owner。
   * @param handle 当前 owner 的目录句柄。
   * @param relative 待解析的安全 POSIX 路径。
   * @returns 仍位于当前 workDir 内的绝对路径。
   */
  resolve(owner: string, handle: WorkDirectoryHandle, relative: string): string {
    this.#scope.assertActive();
    /** 只有当前 Registry WeakMap 中的原始对象才是有效句柄。 */
    const record = this.#records.get(handle);
    if (record === undefined || record.session !== this.#scope.token || record.owner !== owner)
      throw new Error('Work directory handle is not authorized for this owner and BuildSession.');
    /** 物理解析前先拒绝路径语法歧义。 */
    const safe = safeRelativePath(relative);
    /** POSIX 作者路径按宿主分隔符逐 segment 拼接。 */
    const candidate = path.join(record.directory, ...safe.split('/'));
    if (!isInsidePath(record.directory, candidate))
      throw new Error('Work directory path escapes its owner root.');
    return candidate;
  }

  /**
   * 为 Core Host 返回已授权 owner workDir 的物理根。
   *
   * @param owner 当前 Host owner。
   * @param handle 当前 owner 的不可伪造句柄。
   * @returns 仅 Core 私有实现可见的绝对根路径。
   */
  physicalRoot(owner: string, handle: WorkDirectoryHandle): string {
    this.#scope.assertActive();
    /** WeakMap 记录同时复核 owner、Session 与对象 identity。 */
    const record = this.#records.get(handle);
    if (record === undefined || record.session !== this.#scope.token || record.owner !== owner)
      throw new Error('Work directory handle is not authorized for this owner and BuildSession.');
    return record.directory;
  }

  /**
   * 验证一个生成文件确实来自指定 owner 的 workDir。
   *
   * @param owner 当前生成操作 owner。
   * @param handle owner workDir 句柄。
   * @param relative workDir-relative 生成文件路径。
   * @returns 已验证普通文件的绝对路径和授权根。
   */
  async generatedFile(owner: string, handle: WorkDirectoryHandle, relative: string): Promise<{ readonly file: string; readonly root: string }> {
    /** resolve 同时完成 Session、owner 和对象身份验证。 */
    const file = this.resolve(owner, handle, relative);
    /** 重新读取授权记录以取得不向 Integration 暴露的物理根。 */
    const record = this.#records.get(handle)!;
    await validatePhysicalEntry(record.directory, file, 'file');
    return Object.freeze({ file, root: record.directory });
  }
}
