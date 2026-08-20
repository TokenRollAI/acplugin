/** 受管输出的稳定路径、marker 与 preserved Platform 文件协议。 */
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { PackageUnitSnapshot } from '../contracts/packages.js';
import {
  compareCodePoints,
  isInsidePath,
  sourceCollisionKey,
} from '../security/path-policy.js';
import { scanPhysicalTree } from '../package/candidate-materializer.js';

/** 完整构建替换所有输出；显式 subset 只替换所选 Platform。 */
export type ManagedOutputScope = {
  readonly type: 'full';
} | {
  readonly type: 'subset';
  readonly platforms: readonly string[];
};

/** 既有未选 Platform 中一个普通文件的稳定快照。 */
interface PreservedFile {
  readonly path: string;
  readonly bytes: Uint8Array;
  readonly mode: 0o644 | 0o755;
  readonly size: number;
  readonly sha256: string;
}
/** 一个未选 Platform 的完整旧输出快照。 */
export interface PreservedPlatform {
  readonly id: string;
  readonly directories: readonly string[];
  readonly files: readonly PreservedFile[];
}

/** 崩溃恢复所需的最小 rollback record。 */
export interface TransactionRecord {
  readonly schemaVersion: 2;
  readonly outDir: string;
  readonly scope: ManagedOutputScope['type'];
  readonly hadOutput: boolean;
}

/** 未完成 marker 只允许存在于这个固定、可恢复的临时后缀。 */
export const MARKER_WRITING_SUFFIX = '.writing';

/** Platform 和 Unit ID 使用的稳定 lowercase-kebab 规则。 */
const STABLE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

/** @returns 路径是否存在；ENOENT 以外错误仍按不存在处理到后续操作。 */
export async function exists(candidate: string): Promise<boolean> {
  try {
    await fs.access(candidate);
    return true;
  } catch {
    return false;
  }
}

/**
 * 持久写入一个不含物理路径的事务 marker。
 *
 * @param file 同一受管输出专属的 marker 路径。
 * @param record 当前事务的稳定恢复信息。
 */
export async function writeTransactionMarker(file: string, record: TransactionRecord): Promise<void> {
  /** 临时普通文件先完整落盘，最终 marker 永远不会暴露部分 JSON。 */
  const writing = `${file}${MARKER_WRITING_SUFFIX}`;
  /** `wx` 防止遗留或并发状态被当前事务静默覆盖。 */
  const handle = await fs.open(writing, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(record)}\n`);
    /** 临时 marker 内容先落盘，随后才允许原子发布最终目录项。 */
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    /** 同目录 hard link 原子发布且拒绝覆盖任何既有最终 marker。 */
    await fs.link(writing, file);
  } finally {
    /** 发布前失败或发布后崩溃遗留的临时链接都不参与恢复判断。 */
    await fs.rm(writing, { force: true });
  }
}

/**
 * 读取并验证一个受管事务 marker。
 *
 * @param file 当前输出专属 marker 路径。
 * @param expectedOutDir 当前受管输出 basename。
 * @returns marker 不存在时返回 undefined。
 */
export async function readTransactionMarker(file: string, expectedOutDir: string): Promise<TransactionRecord | undefined> {
  /** marker 缺失是正常恢复状态。 */
  const stat = await fs.lstat(file).catch(() => undefined);
  if (stat === undefined)
    return undefined;
  if (stat.isSymbolicLink() || !stat.isFile())
    throw new Error('Managed output transaction marker must be a regular file.');
  /** 未验证 JSON 只能用于恢复状态判断，不能提供任意路径。 */
  const value: unknown = JSON.parse(await fs.readFile(file, 'utf8'));
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error('Managed output transaction marker is invalid.');
  /** marker 只允许固定恢复字段。 */
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort(compareCodePoints).join(',') !== 'hadOutput,outDir,schemaVersion,scope'
    || record.schemaVersion !== 2 || record.outDir !== expectedOutDir
    || (record.scope !== 'full' && record.scope !== 'subset') || typeof record.hadOutput !== 'boolean') {
    throw new Error('Managed output transaction marker is invalid.');
  }
  return Object.freeze({
    schemaVersion: 2,
    outDir: record.outDir,
    scope: record.scope,
    hadOutput: record.hadOutput,
  }) as TransactionRecord;
}

/** @returns 字节的 SHA-256 十六进制摘要。 */
function hashBytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * 规范化 transaction scope 并校验与 Unit Platform 集合完全一致。
 *
 * @param scope 调用方选择语义。
 * @param units 本轮待提交 Package Units。
 * @returns frozen full/subset scope。
 */
export function normalizeScope(
  scope: ManagedOutputScope | undefined,
  units: readonly PackageUnitSnapshot[],
): ManagedOutputScope {
  if (scope === undefined || scope.type === 'full')
    return Object.freeze({ type: 'full' });
  if (scope.type !== 'subset' || !Array.isArray(scope.platforms))
    throw new TypeError('Managed output scope is invalid.');
  /** selected IDs 复制、排序并拒绝不稳定或重复值。 */
  const selected = [...scope.platforms].sort(compareCodePoints);
  if (selected.length === 0 || selected.some(platform => !STABLE_ID.test(platform))
    || new Set(selected).size !== selected.length) {
    throw new TypeError('Subset Platform ids must be unique lowercase kebab-case values.');
  }
  /** 成功提交时每个 selected Platform 必须至少存在一个 Unit。 */
  const actual = [...new Set(units.map(unit => unit.platform))].sort(compareCodePoints);
  if (JSON.stringify(actual) !== JSON.stringify(selected))
    throw new TypeError('Subset Platform ids must exactly match the Package Unit Platform set.');
  return Object.freeze({ type: 'subset', platforms: Object.freeze(selected) });
}

/** 单个受管输出对应的固定物理路径协议。 */
export interface ManagedOutputPaths {
  readonly resolved: string;
  readonly parent: string;
  readonly base: string;
  readonly lock: string;
  readonly transaction: string;
  readonly transactionWriting: string;
  readonly committed: string;
  readonly committedWriting: string;
  readonly backup: string;
  readonly stagePrefix: string;
}

/**
 * 验证 outDir 边界并形成全部固定事务路径。
 *
 * @param outDir 受管输出目录。
 * @param projectRoot 工程根目录。
 * @returns 同一受管输出的不可变路径集合。
 */
export function outputPaths(outDir: string, projectRoot: string): ManagedOutputPaths {
  /** 输入路径先解析为绝对位置再判断边界。 */
  const resolved = path.resolve(outDir);
  /** 工程根同样固定为绝对路径。 */
  const project = path.resolve(projectRoot);
  /** basename 用于构造同级事务辅助路径。 */
  const base = path.basename(resolved);
  if (!isInsidePath(project, resolved) || resolved === project
    || resolved === path.parse(resolved).root || base === '' || base === '.' || base === '..') {
    throw new Error('Managed output must stay strictly inside the project root.');
  }
  /** 所有辅助路径与 outDir 同级，保证 rename 不跨文件系统。 */
  const parent = path.dirname(resolved);
  /** pending 与 committed marker 使用固定、互不覆盖的名称。 */
  const transaction = path.join(parent, `.${base}.acplugin-transaction.json`);
  /** committed marker 只在 cleanup 必要条件完成后发布。 */
  const committed = path.join(parent, `.${base}.acplugin-committed.json`);
  return Object.freeze({
    resolved,
    parent,
    base,
    lock: path.join(parent, `.${base}.acplugin.lock`),
    transaction,
    transactionWriting: `${transaction}${MARKER_WRITING_SUFFIX}`,
    committed,
    committedWriting: `${committed}${MARKER_WRITING_SUFFIX}`,
    backup: path.join(parent, `.${base}.acplugin-backup`),
    stagePrefix: `.${base}.acplugin-stage-`,
  });
}

/**
 * 读取一个未选 Platform 的完整旧输出，拒绝非普通内容和路径碰撞。
 *
 * @param root Platform 物理根。
 * @param id Platform ID。
 * @returns 可复制并在 swap 前复核的内存快照。
 */
async function snapshotPreservedPlatform(root: string, id: string): Promise<PreservedPlatform> {
  /** scanPhysicalTree 统一拒绝 symlink/special file。 */
  const tree = await scanPhysicalTree(root);
  /** 路径索引额外拒绝大小写和 NFC collision。 */
  const collision = new Map<string, string>();
  for (const relative of [...tree.directories, ...tree.files]) {
    /** 所有目录和文件共享同一个折叠 collision domain。 */
    const key = sourceCollisionKey(relative);
    /** 首次出现的原始 path 用于稳定诊断。 */
    const previous = collision.get(key);
    if (previous !== undefined)
      throw new Error(`Preserved Platform path "${relative}" collides with "${previous}".`);
    collision.set(key, relative);
  }
  /** file snapshots 与目录 closure 分开保存。 */
  const files: PreservedFile[] = [];
  for (const relative of tree.files) {
    /** 文件字节一次性复制，旧输出不会成为新 AssetRef 来源。 */
    const file = path.join(root, ...relative.split('/'));
    /** mode 只接受框架 Asset 支持的两种权限。 */
    const stat = await fs.lstat(file);
    /** 权限去除文件类型位后参与 snapshot。 */
    const mode = stat.mode & 0o777;
    if (mode !== 0o644 && mode !== 0o755)
      throw new Error(`Preserved Platform file has unsupported mode: ${id}/${relative}.`);
    /** 内容 snapshot 同时固定 size/hash。 */
    const bytes = Uint8Array.from(await fs.readFile(file));
    files.push(Object.freeze({
      path: relative,
      bytes,
      mode,
      size: bytes.byteLength,
      sha256: hashBytes(bytes),
    }));
  }
  return Object.freeze({ id, directories: tree.directories, files: Object.freeze(files) });
}

/**
 * 在取得 transaction lock 后快照所有未选 Platform。
 *
 * @param outDir 当前受管输出。
 * @param selected 本轮显式替换的 Platform。
 * @returns 按 Platform ID 排序的旧输出快照。
 */
export async function snapshotPreservedPlatforms(
  outDir: string,
  selected: ReadonlySet<string>,
): Promise<readonly PreservedPlatform[]> {
  if (!await exists(outDir))
    return Object.freeze([]);
  /** outDir 自身也不能是 symlink 或普通文件。 */
  const stat = await fs.lstat(outDir);
  if (stat.isSymbolicLink() || !stat.isDirectory())
    throw new Error('Managed output root must be a regular directory.');
  /** outDir 顶层只能包含 lowercase-kebab Platform 目录。 */
  const entries = (await fs.readdir(outDir, { withFileTypes: true }))
    .sort((left, right) => compareCodePoints(left.name, right.name));
  /** 未选 Platform 按目录顺序进入快照。 */
  const preserved: PreservedPlatform[] = [];
  /** 顶层 Platform ID 也拒绝 case/NFC collision。 */
  const collisions = new Map<string, string>();
  for (const entry of entries) {
    if (!STABLE_ID.test(entry.name) || !entry.isDirectory() || entry.isSymbolicLink())
      throw new Error(`Managed output contains an invalid Platform root: "${entry.name}".`);
    /** Platform ID 使用与 Package path 相同的折叠 key。 */
    const key = sourceCollisionKey(entry.name);
    /** 首次 Platform 名用于冲突诊断。 */
    const previous = collisions.get(key);
    if (previous !== undefined)
      throw new Error(`Managed output Platform "${entry.name}" collides with "${previous}".`);
    collisions.set(key, entry.name);
    if (!selected.has(entry.name))
      preserved.push(await snapshotPreservedPlatform(path.join(outDir, entry.name), entry.name));
  }
  return Object.freeze(preserved);
}

/**
 * 把未选 Platform snapshot 写入 stage。
 *
 * @param stage 当前事务 stage 根。
 * @param platforms 旧输出内存快照。
 */
export async function materializePreservedPlatforms(
  stage: string,
  platforms: readonly PreservedPlatform[],
): Promise<void> {
  for (const platform of platforms) {
    /** Platform 根本身即使为空也必须保留。 */
    const root = path.join(stage, platform.id);
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    for (const directory of platform.directories)
      await fs.mkdir(path.join(root, ...directory.split('/')), { recursive: true, mode: 0o700 });
    for (const file of platform.files) {
      /** 文件写入不复用 copyFile，确保使用已快照的确定字节。 */
      const destination = path.join(root, ...file.path.split('/'));
      await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
      await fs.writeFile(destination, file.bytes, { flag: 'wx', mode: file.mode });
      await fs.chmod(destination, file.mode);
    }
  }
}

/**
 * 复核保留 Platform 的树闭包、字节和 mode。
 *
 * @param parent outDir 或 stage 根。
 * @param platforms 先前建立的完整快照。
 */
export async function validatePreservedPlatforms(
  parent: string,
  platforms: readonly PreservedPlatform[],
): Promise<void> {
  for (const platform of platforms) {
    /** preserved validation 始终从 Platform root 开始。 */
    const root = path.join(parent, platform.id);
    /** closure 比较拒绝外部在 snapshot 后增删文件或目录。 */
    const tree = await scanPhysicalTree(root);
    if (JSON.stringify(tree.directories) !== JSON.stringify(platform.directories)
      || JSON.stringify(tree.files) !== JSON.stringify(platform.files.map(file => file.path))) {
      throw new Error(`Preserved Platform tree changed during transaction: ${platform.id}.`);
    }
    for (const expected of platform.files) {
      /** 每个文件重新读取以验证 source/stage 都等于同一 snapshot。 */
      const file = path.join(root, ...expected.path.split('/'));
      /** mode 从 lstat 获取，避免最终 symlink 跟随。 */
      const stat = await fs.lstat(file);
      /** bytes 再次复算 size/hash。 */
      const bytes = Uint8Array.from(await fs.readFile(file));
      if ((stat.mode & 0o777) !== expected.mode || bytes.byteLength !== expected.size
        || hashBytes(bytes) !== expected.sha256) {
        throw new Error(`Preserved Platform file changed during transaction: ${platform.id}/${expected.path}.`);
      }
    }
  }
}

/**
 * 校验 stage 顶层只包含本轮 Unit 与保留 Platform 的完整集合。
 *
 * @param stage 当前 stage 根。
 * @param units 本轮新 Package Units。
 * @param preserved 未选 Platform snapshots。
 */
export async function validateStagePlatforms(
  stage: string,
  units: readonly PackageUnitSnapshot[],
  preserved: readonly PreservedPlatform[],
): Promise<void> {
  /** expected 顶层由新 Unit Platform 与 preserved Platform 并集组成。 */
  const expected = [...new Set([
    ...units.map(unit => unit.platform),
    ...preserved.map(platform => platform.id),
  ])].sort(compareCodePoints);
  /** stage 顶层实际目录集合也必须完整闭合。 */
  const actual = (await fs.readdir(stage, { withFileTypes: true }))
    .map((entry) => {
      if (!entry.isDirectory() || entry.isSymbolicLink())
        throw new Error(`Managed stage contains a non-directory Platform root: "${entry.name}".`);
      return entry.name;
    })
    .sort(compareCodePoints);
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw new Error('Managed stage Platform closure mismatch.');
}

/** 把即将 swap 的最终 stage 全部目录规范为公开可遍历的 0755。 */
export async function normalizeFinalDirectoryModes(stage: string): Promise<void> {
  if (process.platform === 'win32')
    return;
  /** scan 先证明整棵 stage 不含 symlink 或特殊文件。 */
  const tree = await scanPhysicalTree(stage);
  /** 后代先 chmod，最后处理会成为 outDir 的 stage root。 */
  for (const directory of tree.directories)
    await fs.chmod(path.join(stage, ...directory.split('/')), 0o755);
  await fs.chmod(stage, 0o755);
}

/** 复核 stage 根和所有后代目录的最终 POSIX mode。 */
export async function validateFinalDirectoryModes(stage: string): Promise<void> {
  if (process.platform === 'win32')
    return;
  /** scan 同时返回完整目录闭包并拒绝非普通内容。 */
  const tree = await scanPhysicalTree(stage);
  for (const directory of ['', ...tree.directories]) {
    /** 空字符串表示最终 outDir 根自身。 */
    const physical = directory === '' ? stage : path.join(stage, ...directory.split('/'));
    /** lstat 复核当前目录没有被替换且使用最终公开 mode。 */
    const stat = await fs.lstat(physical);
    if ((stat.mode & 0o777) !== 0o755)
      throw new Error('Managed stage directories must use mode 0755.');
  }
}
