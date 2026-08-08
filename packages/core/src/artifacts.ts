import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { OutputPathRegistry } from './output-paths.js';
import { compareCodeUnits } from './serialization.js';
import type { Artifact, ArtifactInput, ArtifactMode } from './types.js';

/** 单个精确文件来源及其必须保持无符号链接的信任根。 */
export interface ArtifactSourceFileAuthorization {
  readonly path: string;
  readonly root: string;
}

/** 一个 Artifact owner 可以读取的独占目录与已扫描精确文件。 */
export interface ArtifactSourcePolicy {
  readonly roots?: readonly string[];
  readonly files?: readonly ArtifactSourceFileAuthorization[];
}

/** 按完整 owner 名称隔离的 Artifact 文件来源授权表。 */
export type ArtifactSourcePolicies = ReadonlyMap<string, ArtifactSourcePolicy>;

/**
 * 判断候选路径是否位于指定根目录内，或与根目录本身相同。
 *
 * @param root 已解析为绝对路径的可信根目录。
 * @param candidate 需要验证的绝对路径。
 * @returns 候选路径没有通过 `..` 或其他盘符逃逸时返回 true。
 */
function isInside(root: string, candidate: string): boolean {
  // 使用 path.relative 而不是字符串前缀，避免 `/project-a` 被误判为 `/project` 的子目录。
  const relative = path.relative(root, candidate);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

/**
 * 以流式方式计算文件的 SHA-256 和字节数，避免把大型公共资源整体读入内存。
 *
 * @param file 需要读取的文件绝对路径。
 * @returns 文件内容摘要与实际字节数。
 */
export async function hashFile(file: string): Promise<{ sha256: string; size: number }> {
  /** 在读取文件的同时增量更新的 SHA-256 计算器。 */
  const hash = createHash('sha256');
  /** 已从文件流接收的累计字节数。 */
  let size = 0;
  await new Promise<void>((resolve, reject) => {
    // 流错误必须传递给调用方，否则可能把不完整读取误认为有效 Artifact。
    const stream = createReadStream(file);
    stream.on('data', (chunk) => {
      size += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length;
      hash.update(chunk);
    });
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  return { sha256: hash.digest('hex'), size };
}

/**
 * 收集一次构建产生的全部 Artifact，并维护路径唯一性和来源可信边界。
 *
 * Graph 只接受内存快照或可信源目录中的普通文件；加入后的元数据不可变，
 * 从而为后续事务写入和构建报告提供确定输入。
 */
export class ArtifactRegistry {
  /** 以规范化目标路径索引的不可变 Artifact。 */
  readonly #artifacts = new Map<string, Artifact>();
  /** 固定生命周期按 owner 隔离的精确来源授权。 */
  readonly #sourcePolicies: ArtifactSourcePolicies;
  /** 与 Document 共享或由当前 Registry 独占的输出路径占用表。 */
  readonly #paths: OutputPathRegistry;

  /**
   * 创建单次构建使用的 Artifact 图。
   *
   * @param sourcePolicies 固定生命周期按 owner 隔离的来源授权表。
   * @param paths 可选的共享路径占用表，用于同时检查 Document 与 Artifact。
   */
  constructor(sourcePolicies: ArtifactSourcePolicies, paths: OutputPathRegistry = new OutputPathRegistry()) {
    /** 复制并解析全部路径，阻止调用方在构建期间替换授权 Map 或数组。 */
    const policies = new Map<string, ArtifactSourcePolicy>();
    for (const [owner, policy] of sourcePolicies) {
      policies.set(owner, Object.freeze({
        roots: Object.freeze((policy.roots ?? []).map(root => path.resolve(root))),
        files: Object.freeze((policy.files ?? []).map(file => Object.freeze({
          path: path.resolve(file.path),
          root: path.resolve(file.root),
        }))),
      }));
    }
    this.#sourcePolicies = policies;
    this.#paths = paths;
  }

  /**
   * 为当前 owner 和精确文件来源选择最具体的信任根。
   *
   * @param owner Artifact 的固定所有者。
   * @param sourcePath 已解析的绝对文件路径。
   * @returns 可用于逐层 lstat 的授权根；没有授权时返回 undefined。
   */
  #allowedRoot(owner: string, sourcePath: string): string | undefined {
    /** 当前 owner 独占且不能回退到其他对象授权的来源策略。 */
    const policy = this.#sourcePolicies.get(owner);
    if (!policy)
      return undefined;
    /** 目录授权和精确扫描文件授权共同产生的候选信任根。 */
    const roots = [
      ...(policy.roots ?? []).filter(root => isInside(root, sourcePath)),
      ...(policy.files ?? [])
        .filter(file => file.path === sourcePath && isInside(file.root, sourcePath))
        .map(file => file.root),
    ];
    return roots.sort((left, right) => right.length - left.length)[0];
  }

  /**
   * 返回按目标路径稳定排序的 Artifact 快照。
   *
   * @returns 不暴露内部 Map 顺序和可变性的只读列表。
   */
  get artifacts(): readonly Artifact[] {
    return Object.freeze([...this.#artifacts.values()].sort((a, b) => compareCodeUnits(a.path, b.path)));
  }

  /**
   * 验证并加入一个构建产物。
   *
   * @param owner 负责生成该产物的 Platform 或 Extension 标识。
   * @param input 尚未校验的 Artifact 描述。
   * @returns 已冻结且带内容摘要的 Artifact。
   * @throws 目标路径冲突、权限模式非法或文件来源越过可信根目录时抛出异常。
   */
  async add(owner: string, input: ArtifactInput): Promise<Artifact> {
    /** 最终写入权限只允许普通文件与可执行文件两种可移植模式。 */
    let mode: ArtifactMode | undefined = input.mode;
    if (mode !== undefined && mode !== 0o644 && mode !== 0o755)
      throw new Error(`Unsupported Artifact mode for ${input.path}.`);
    /** 经过目录逃逸与 Unicode 规范化检查的最终目标路径。 */
    const reservation = this.#paths.reserve(owner, 'artifact', input.path);
    /** 与共享路径占用记录一致的规范 Artifact 路径。 */
    const artifactPath = reservation.path;

    try {
      /** 在加入 Registry 时确定的内容字节数。 */
      let size: number;
      /** 在加入 Registry 时确定的内容摘要，用于报告和事务校验。 */
      let sha256: string;
      /** 与摘要对应的不可变内存快照或已验证文件来源。 */
      let source: Artifact['source'];
      if (input.source.type === 'bytes') {
        /** 复制后的 Registry 内部字节快照。 */
        const value = Uint8Array.from(input.source.value);
        mode ??= 0o644;
        size = value.byteLength;
        sha256 = createHash('sha256').update(value).digest('hex');
        source = Object.freeze({
          type: 'bytes' as const,
          /** 每次返回副本，阻止调用方通过下标修改 Registry 内部快照。 */
          get value() { return Uint8Array.from(value); },
        });
      } else {
        /** 解析后的文件来源路径，后续所有安全判断都基于该绝对路径。 */
        const sourcePath = path.resolve(input.source.path);
        /** 最具体的可信根用于检查根目录以下的每一层符号链接。 */
        const allowedRoot = this.#allowedRoot(owner, sourcePath);
        if (!allowedRoot)
          throw new Error(`Artifact source is outside allowed roots for owner "${owner}": ${input.source.path}`);
        /** 从可信根到文件的每一级路径片段。 */
        const segments = path.relative(allowedRoot, sourcePath).split(path.sep).filter(Boolean);
        /** 当前执行 lstat 且不得为符号链接的来源路径。 */
        let current = allowedRoot;
        for (const segment of segments) {
          current = path.join(current, segment);
          /** 当前层级的文件类型，用于阻断信任根以下的符号链接跳转。 */
          const currentStat = await fs.lstat(current);
          if (currentStat.isSymbolicLink())
            throw new Error(`Artifact source must not contain symbolic links: ${input.source.path}`);
        }
        /** 最终来源必须是普通文件而不是目录或特殊设备。 */
        const stat = await fs.lstat(sourcePath);
        if (!stat.isFile())
          throw new Error(`Artifact source must be a regular non-symlink file: ${input.source.path}`);
        mode ??= stat.mode & 0o111 ? 0o755 : 0o644;
        ({ size, sha256 } = await hashFile(sourcePath));
        source = Object.freeze({ type: 'file', path: sourcePath });
      }

      /** 完成路径、来源和摘要验证后对外暴露的最终产物记录。 */
      const artifact: Artifact = Object.freeze({
        path: artifactPath,
        source,
        owner,
        mode,
        size,
        sha256,
      });
      this.#artifacts.set(artifactPath, artifact);
      return artifact;
    } catch /** error 保存当前操作捕获的异常，供本阶段转换或恢复。 */ (error) {
      // 内容或来源验证失败不能永久占用路径，便于调用方修正后在同一 Registry 重试。
      this.#paths.release(artifactPath);
      throw error;
    }
  }
}

/**
 * 创建内存型 Artifact 输入，常用于生成清单、配置和 Markdown 文件。
 *
 * @param pathname 产物相对于目标根目录的 POSIX 路径。
 * @param content UTF-8 文本或调用方提供的原始字节。
 * @param mode 可选的目标文件权限模式。
 * @returns 可交给 ArtifactRegistry 校验和快照化的输入。
 */
export function bytesArtifact(pathname: string, content: string | Uint8Array, mode?: ArtifactMode): ArtifactInput {
  /** 统一为字节表示；ArtifactRegistry.add 会再次复制以建立所有权边界。 */
  const value = typeof content === 'string' ? new TextEncoder().encode(content) : content;
  /** 尚未进入 Graph、因此尚未带摘要信息的不可变内存产物输入。 */
  return {
    path: pathname,
    source: { type: 'bytes', value },
    ...(mode === undefined ? {} : { mode }),
  };
}
