import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {
  PackageCandidate,
  PackageUnitSnapshot,
} from '../contracts/packages.js';
import { AssetRegistry } from '../services/assets.js';
import { compareCodePoints, safeRelativePath, sourceCollisionKey } from '../security/path-policy.js';

/** Package Unit Platform/ID 共用的 lowercase-kebab 规则。 */
const STABLE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

/** Candidate handle 将绝对临时路径限制在 validator 调用窗口。 */
export interface PackageCandidateHandle {
  readonly candidate: PackageCandidate;
  /** validator 返回后复核完整树、字节和 mode。 */
  readonly validate: () => Promise<void>;
  /** 无论成功失败都幂等移除 candidate。 */
  readonly cleanup: () => Promise<void>;
}

/** 单个 Package Unit 预检后的完整路径和 Asset metadata。 */
export interface MaterializationEntry {
  readonly path: string;
  readonly asset: PackageUnitSnapshot['assets'][number]['asset'];
  readonly mode: 0o644 | 0o755;
  readonly size: number;
  readonly sha256: string;
}

/** @returns 文件字节的 SHA-256 十六进制摘要。 */
function hashBytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * 验证一个 Unit 的身份、Asset snapshot 和完整路径闭包。
 *
 * @param unit Core 建立的 Package Unit snapshot。
 * @param assets 当前 BuildSession Asset Registry。
 * @returns 按路径排序的物化输入。
 */
function preflightUnit(unit: PackageUnitSnapshot, assets: AssetRegistry): readonly MaterializationEntry[] {
  if (!STABLE_ID.test(unit.platform) || !STABLE_ID.test(unit.id))
    throw new TypeError('Package Unit Platform and id must use lowercase kebab-case.');
  if ((unit.role === 'primary' && unit.type === 'marketplace')
    || (unit.role === 'distribution' && unit.type !== 'marketplace')) {
    throw new TypeError('Package Unit role and type are inconsistent.');
  }
  /** exact/case/NFC 与文件/目录前缀共用一个本地索引。 */
  const paths = new Map<string, string>();
  /** entries 保留 materialization 所需的完整性基准。 */
  const entries: MaterializationEntry[] = [];
  /** Unit 的 Platform owner 必须拥有所有 ref grant。 */
  const owner = `platform:${unit.platform}`;
  for (const mapping of unit.assets) {
    /** Unit path 在接触文件系统前通过完整路径策略。 */
    const safe = safeRelativePath(mapping.path);
    /** collision key 折叠大小写和 NFC。 */
    const key = sourceCollisionKey(safe);
    for (const [existingKey, existingPath] of paths) {
      if (key === existingKey || key.startsWith(`${existingKey}/`) || existingKey.startsWith(`${key}/`))
        throw new TypeError(`Package Asset path "${safe}" collides with "${existingPath}".`);
    }
    paths.set(key, safe);
    /** describe 复核 ref identity、Platform grant、BuildSession 与 issuer owner。 */
    const record = assets.describe(owner, mapping.asset);
    if (record.owner !== mapping.owner)
      throw new TypeError(`Package Asset owner mismatch at "${safe}".`);
    entries.push(Object.freeze({
      path: safe,
      asset: mapping.asset,
      mode: record.mode,
      size: record.size,
      sha256: record.sha256,
    }));
  }
  return Object.freeze(entries.sort((left, right) => compareCodePoints(left.path, right.path)));
}

/**
 * 把一个 Unit 的全部 AssetRef 写入一个新建空目录。
 *
 * @param root 当前 Unit 独占物化根。
 * @param unit Package Unit snapshot。
 * @param assets 当前 Asset Registry。
 * @returns 后续完整性复核使用的稳定 entries。
 */
async function materializeUnitRoot(
  root: string,
  unit: PackageUnitSnapshot,
  assets: AssetRegistry,
): Promise<readonly MaterializationEntry[]> {
  /** preflight 必须先完整成功，不能写出部分不合法 Unit。 */
  const entries = preflightUnit(unit, assets);
  /** 所有 Asset 读取都使用 Platform owner grant。 */
  const owner = `platform:${unit.platform}`;
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  for (const entry of entries) {
    /** safe POSIX segments 逐段交给宿主 path join。 */
    const destination = path.join(root, ...entry.path.split('/'));
    await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    /** materializationBytes 在每次落盘前重新执行来源 TOCTOU 校验。 */
    const bytes = await assets.materializationBytes(owner, entry.asset);
    if (bytes.byteLength !== entry.size || hashBytes(bytes) !== entry.sha256)
      throw new Error(`Package Asset changed before materialization: ${unit.platform}/${unit.id}/${entry.path}.`);
    await fs.writeFile(destination, bytes, { flag: 'wx', mode: entry.mode });
    await fs.chmod(destination, entry.mode);
  }
  return entries;
}

/**
 * 递归收集物化树中的全部目录和普通文件，拒绝 symlink 与特殊文件。
 *
 * @param root 当前 Unit 物化根。
 * @returns 工程无关的 POSIX 相对路径集合。
 */
export async function scanPhysicalTree(root: string): Promise<{
  readonly files: readonly string[];
  readonly directories: readonly string[];
}> {
  /** root 自身也必须保持普通目录，不能被 validator 替换为 symlink。 */
  const rootStat = await fs.lstat(root);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory())
    throw new Error('Materialized Package root must remain a regular directory.');
  /** 文件和目录分开比较，防止 validator 注入空目录。 */
  const files: string[] = [];
  /** directory closure 包含所有显式和隐式目录。 */
  const directories: string[] = [];
  /** 递归只沿 lstat 已证明的普通目录进入。 */
  const visit = async (relative: string): Promise<void> => {
    /** root 使用空 relative，后代按 POSIX segment 转宿主路径。 */
    const current = relative.length === 0 ? root : path.join(root, ...relative.split('/'));
    /** readdir 结果显式按 code point 排序，消除文件系统顺序差异。 */
    const entries = (await fs.readdir(current, { withFileTypes: true }))
      .sort((left, right) => compareCodePoints(left.name, right.name));
    for (const entry of entries) {
      /** 文件系统名称也必须可无歧义表示为安全相对路径。 */
      const child = relative.length === 0 ? entry.name : `${relative}/${entry.name}`;
      safeRelativePath(child);
      /** child 的物理位置只由安全 segment 拼接。 */
      const physical = path.join(root, ...child.split('/'));
      /** lstat 保证符号链接不会被跟随。 */
      const stat = await fs.lstat(physical);
      if (stat.isSymbolicLink())
        throw new Error(`Materialized Package contains a symbolic link at "${child}".`);
      if (stat.isDirectory()) {
        directories.push(child);
        await visit(child);
      } else if (stat.isFile()) {
        files.push(child);
      } else {
        throw new Error(`Materialized Package contains a special file at "${child}".`);
      }
    }
  };
  await visit('');
  /** DFS 完成后全局排序，避免嵌套前序与 code-point 顺序不一致。 */
  files.sort(compareCodePoints);
  directories.sort(compareCodePoints);
  return Object.freeze({ files: Object.freeze(files), directories: Object.freeze(directories) });
}

/** @returns 期望文件路径隐含的完整目录集合。 */
function expectedDirectories(files: readonly string[]): readonly string[] {
  /** 多个文件共享目录时使用 Set 去重。 */
  const directories = new Set<string>();
  for (const file of files) {
    /** 每个文件逐级产生其父目录前缀。 */
    const segments = file.split('/');
    for (let length = 1; length < segments.length; length += 1)
      directories.add(segments.slice(0, length).join('/'));
  }
  return Object.freeze([...directories].sort(compareCodePoints));
}

/**
 * 复核 Unit 物化后的完整树、文件字节、权限和摘要。
 *
 * @param root 当前 Unit 物化根。
 * @param unit Package Unit identity。
 * @param entries preflight 建立的完整性基准。
 */
async function validateUnitRoot(
  root: string,
  unit: PackageUnitSnapshot,
  entries: readonly MaterializationEntry[],
): Promise<void> {
  /** tree closure 同时拒绝额外文件和额外空目录。 */
  const tree = await scanPhysicalTree(root);
  /** entries 本身已按 path 排序。 */
  const expectedFiles = entries.map(entry => entry.path);
  if (JSON.stringify(tree.files) !== JSON.stringify(expectedFiles)
    || JSON.stringify(tree.directories) !== JSON.stringify(expectedDirectories(expectedFiles))) {
    throw new Error(`Materialized Package tree closure mismatch: ${unit.platform}/${unit.id}.`);
  }
  for (const entry of entries) {
    /** 已通过 closure 的目标必然是普通文件且没有 symlink 祖先。 */
    const file = path.join(root, ...entry.path.split('/'));
    /** mode 由 lstat 读取，不跟随最终 symlink。 */
    const stat = await fs.lstat(file);
    /** bytes 用于独立复算 size/hash。 */
    const bytes = Uint8Array.from(await fs.readFile(file));
    if (bytes.byteLength !== entry.size || hashBytes(bytes) !== entry.sha256)
      throw new Error(`Materialized Package integrity mismatch: ${unit.platform}/${unit.id}/${entry.path}.`);
    if ((stat.mode & 0o777) !== entry.mode)
      throw new Error(`Materialized Package mode mismatch: ${unit.platform}/${unit.id}/${entry.path}.`);
  }
}

/**
 * 在 Core 临时目录建立一个只在 validator 窗口有效的 Package candidate。
 *
 * @param unit 已冻结 Package Unit。
 * @param assets 当前 Asset Registry。
 * @param temporaryParent 可选受管临时父目录。
 * @returns 含 validate/cleanup 的候选句柄。
 */
export async function materializePackageCandidate(
  unit: PackageUnitSnapshot,
  assets: AssetRegistry,
  temporaryParent: string = os.tmpdir(),
): Promise<PackageCandidateHandle> {
  await fs.mkdir(temporaryParent, { recursive: true, mode: 0o700 });
  /** mkdtemp 产生只属于当前 candidate 的物理根。 */
  const root = await fs.mkdtemp(path.join(temporaryParent, 'acplugin-candidate-'));
  try {
    /** candidate 创建时先完成一次全量物化。 */
    const entries = await materializeUnitRoot(root, unit, assets);
    await validateUnitRoot(root, unit, entries);
    /** cleaned 保证 validator 与错误路径可重复调用 cleanup。 */
    let cleaned = false;
    return Object.freeze({
      candidate: Object.freeze({ root, unit }),
      /** validate 不信任 Platform callback 返回后的磁盘状态。 */
      validate: () => validateUnitRoot(root, unit, entries),
      /** cleanup 可由 finally 和调用方重复安全执行。 */
      cleanup: async () => {
        if (cleaned)
          return;
        cleaned = true;
        await fs.rm(root, { recursive: true, force: true });
      },
    });
  } catch (error) {
    await fs.rm(root, { recursive: true, force: true });
    throw error;
  }
}

/**
 * 执行 Platform validator 并在返回后复核 candidate 未被修改。
 *
 * @param unit 当前 Package Unit。
 * @param assets 当前 Asset Registry。
 * @param validate Platform validator callback。
 * @param temporaryParent 可选受管 candidate 父目录。
 */
export async function withPackageCandidate(
  unit: PackageUnitSnapshot,
  assets: AssetRegistry,
  validate: (candidate: PackageCandidate) => void | Promise<void>,
  temporaryParent?: string,
): Promise<void> {
  /** candidate handle 的生命周期严格包围一次 validator 调用。 */
  const handle = await materializePackageCandidate(unit, assets, temporaryParent);
  try {
    await validate(handle.candidate);
    await handle.validate();
  } finally {
    await handle.cleanup();
  }
}

/**
 * 把全部 Package Unit 写入 `<platform>/<unit-id>` 两级 stage 布局。
 *
 * @param root 新建 stage 根。
 * @param units 本轮 selected Package Units。
 * @param assets 当前 Asset Registry。
 * @returns 每个 Unit root 的完整性基准。
 */
export async function materializePackageUnits(
  root: string,
  units: readonly PackageUnitSnapshot[],
  assets: AssetRegistry,
): Promise<ReadonlyMap<string, readonly MaterializationEntry[]>> {
  /** Unit roots 拒绝 Platform/ID 重复。 */
  const roots = new Map<string, readonly MaterializationEntry[]>();
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  /** Unit 完成顺序不影响 stage 物化顺序。 */
  const ordered = [...units].sort((left, right) => compareCodePoints(left.platform, right.platform) || compareCodePoints(left.id, right.id));
  for (const unit of ordered) {
    /** 两级 root 只来自已验证 lowercase-kebab identities。 */
    const key = `${unit.platform}/${unit.id}`;
    if (roots.has(key))
      throw new TypeError(`Duplicate Package Unit "${key}".`);
    /** Unit 物理 root 固定为 `<platform>/<unit-id>`。 */
    const directory = path.join(root, unit.platform, unit.id);
    roots.set(key, await materializeUnitRoot(directory, unit, assets));
  }
  return roots;
}

/**
 * 复核已由 materializePackageUnits 写出的完整 selected Unit 集合。
 *
 * @param root stage 根。
 * @param units 当前 selected Units。
 * @param entries 物化时建立的每 Unit 基准。
 */
export async function validatePackageUnits(
  root: string,
  units: readonly PackageUnitSnapshot[],
  entries: ReadonlyMap<string, readonly MaterializationEntry[]>,
): Promise<void> {
  for (const unit of units) {
    /** 每个 Unit 必须存在对应 preflight 基准。 */
    const key = `${unit.platform}/${unit.id}`;
    /** materialization baseline 不能由 validator 或 transaction 补造。 */
    const expected = entries.get(key);
    if (expected === undefined)
      throw new Error(`Package Unit materialization baseline is missing: ${key}.`);
    await validateUnitRoot(path.join(root, unit.platform, unit.id), unit, expected);
  }
}
