import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Artifact, ArtifactInput, ArtifactMode } from './types.js';

/**
 * 将用户提供的产物路径规范化为安全、稳定的 POSIX 相对路径。
 *
 * 路径会统一为 NFC，以避免视觉相同但编码不同的文件绕过冲突检测。
 *
 * @param value 配置或 Module 提供的目标路径。
 * @returns 可作为 Artifact 唯一标识的规范化路径。
 * @throws 路径使用反斜杠、绝对路径或能够逃逸目标根目录时抛出异常。
 */
function normalizeArtifactPath(value: string): string {
  if (value.includes('\\'))
    throw new Error(`Artifact path must use POSIX separators: ${value}`);
  if (path.posix.isAbsolute(value))
    throw new Error(`Artifact path must be relative: ${value}`);
  // 规范化分隔片段和 Unicode 编码后，再判断是否仍处于目标根目录内。
  const normalized = path.posix.normalize(value).normalize('NFC');
  if (normalized === '.' || normalized === '' || normalized === '..' || normalized.startsWith('../'))
    throw new Error(`Artifact path escapes the target root: ${value}`);
  return normalized;
}

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
export class ArtifactGraph {
  /** 以规范化目标路径索引的不可变 Artifact。 */
  readonly #artifacts = new Map<string, Artifact>();
  /** 以大小写不敏感键索引原始路径，用于跨文件系统发现路径碰撞。 */
  readonly #normalizedPaths = new Map<string, string>();
  /** 允许文件型 Artifact 读取的绝对源目录集合。 */
  readonly #allowedSourceRoots: readonly string[];

  /**
   * 创建单次构建使用的 Artifact 图。
   *
   * @param allowedSourceRoots Scanner、Public 等允许贡献文件的可信根目录。
   */
  constructor(allowedSourceRoots: readonly string[]) {
    this.#allowedSourceRoots = allowedSourceRoots.map(root => path.resolve(root));
  }

  /**
   * 返回按目标路径稳定排序的 Artifact 快照。
   *
   * @returns 不暴露内部 Map 顺序和可变性的只读列表。
   */
  get artifacts(): readonly Artifact[] {
    return [...this.#artifacts.values()].sort((a, b) => a.path.localeCompare(b.path, 'en'));
  }

  /**
   * 验证并加入一个构建产物。
   *
   * @param owner 负责生成该产物的 Compiler 或 Module 标识。
   * @param input 尚未校验的 Artifact 描述。
   * @returns 已冻结且带内容摘要的 Artifact。
   * @throws 目标路径冲突、权限模式非法或文件来源越过可信根目录时抛出异常。
   */
  async add(owner: string, input: ArtifactInput): Promise<Artifact> {
    /** 经过目录逃逸与 Unicode 规范化检查的最终目标路径。 */
    const artifactPath = normalizeArtifactPath(input.path);
    // 大小写不敏感键保证同一构建在 Linux、macOS 和 Windows 上具有一致的冲突结果。
    const collisionKey = artifactPath.toLocaleLowerCase('en-US').normalize('NFC');
    /** 已占用同一跨平台路径键的产物路径。 */
    const existingPath = this.#normalizedPaths.get(collisionKey);
    if (existingPath)
      throw new Error(`Artifact collision between "${existingPath}" and "${artifactPath}".`);

    /** 最终写入权限只允许普通文件与可执行文件两种可移植模式。 */
    const mode: ArtifactMode = input.mode ?? 0o644;
    if (mode !== 0o644 && mode !== 0o755)
      throw new Error(`Unsupported Artifact mode for ${artifactPath}.`);

    /** 在加入 Graph 时确定的内容字节数。 */
    let size: number;
    /** 在加入 Graph 时确定的内容摘要，用于报告和事务校验。 */
    let sha256: string;
    /** 与摘要对应的不可变内存快照或已验证文件来源。 */
    let source: Artifact['source'];
    if (input.source.type === 'bytes') {
      // 复制调用方的 Uint8Array，避免其在 add 返回后修改已计算摘要对应的内容。
      const value = Uint8Array.from(input.source.value);
      size = value.byteLength;
      sha256 = createHash('sha256').update(value).digest('hex');
      source = Object.freeze({ type: 'bytes', value });
    } else {
      /** 解析后的文件来源路径，后续所有安全判断都基于该绝对路径。 */
      const sourcePath = path.resolve(input.source.path);
      if (!this.#allowedSourceRoots.some(root => isInside(root, sourcePath)))
        throw new Error(`Artifact source is outside allowed roots: ${input.source.path}`);
      // 使用 lstat 拒绝符号链接，防止校验可信路径后再间接读取边界外文件。
      const stat = await fs.lstat(sourcePath);
      if (stat.isSymbolicLink() || !stat.isFile())
        throw new Error(`Artifact source must be a regular non-symlink file: ${input.source.path}`);
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
    this.#normalizedPaths.set(collisionKey, artifactPath);
    return artifact;
  }
}

/**
 * 创建内存型 Artifact 输入，常用于生成清单、配置和 Markdown 文件。
 *
 * @param pathname 产物相对于目标根目录的 POSIX 路径。
 * @param content UTF-8 文本或调用方提供的原始字节。
 * @param mode 可选的目标文件权限模式。
 * @returns 可交给 ArtifactGraph 校验和快照化的输入。
 */
export function bytesArtifact(pathname: string, content: string | Uint8Array, mode?: ArtifactMode): ArtifactInput {
  /** 统一为字节表示；ArtifactGraph.add 会再次复制以建立所有权边界。 */
  const value = typeof content === 'string' ? new TextEncoder().encode(content) : content;
  /** 尚未进入 Graph、因此尚未带摘要信息的内存产物输入。 */
  const artifact: ArtifactInput = { path: pathname, source: { type: 'bytes', value } };
  if (mode !== undefined)
    artifact.mode = mode;
  return artifact;
}
