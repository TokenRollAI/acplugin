import type {
  AssetRef,
  AssetService,
  DistributionPackageInput,
  PackageAssetInput,
  PackageAssetSnapshot,
  PackageUnitSnapshot,
} from '../kernel-types.js';
import { AssetRegistry } from '../kernel/asset-registry.js';
import { dataArrayItems, dataObjectFields } from '../kernel/data-boundary.js';
import { compareCodePoints, safeRelativePath, sourceCollisionKey } from '../kernel/path-policy.js';

/** Distribution 和 Platform ID 共用的 lowercase-kebab 规则。 */
const STABLE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

/** @returns 已验证的 Platform 或 Distribution ID。 */
function stableId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !STABLE_ID.test(value))
    throw new TypeError(`${label} must use lowercase kebab-case.`);
  return value;
}

/**
 * 在一个 Distribution 中登记路径并拒绝 exact/case/NFC/prefix 冲突。
 *
 * @param paths 当前 Distribution 路径闭包。
 * @param value 新路径候选。
 * @returns 安全 package-relative 路径。
 */
function reservePath(paths: Map<string, string>, value: unknown): string {
  /** 路径语法验证不会静默 normalize Integration 输入。 */
  const safe = safeRelativePath(value);
  /** 最严格目标文件系统使用的 collision key。 */
  const key = sourceCollisionKey(safe);
  for (const [reservedKey, reservedPath] of paths) {
    if (key === reservedKey || key.startsWith(`${reservedKey}/`) || reservedKey.startsWith(`${key}/`))
      throw new TypeError(`Distribution path "${safe}" collides with "${reservedPath}".`);
  }
  paths.set(key, safe);
  return safe;
}

/**
 * 从已验证 primary 和当前 callback 新签发 ref 建立 Distribution Unit。
 *
 * @param options Platform、primary、Distribution 输入与授权 Registry。
 * @returns 保留 inherited owner/mode/hash/origin 的 frozen Unit。
 */
export function createDistributionPackage(options: {
  readonly platform: string;
  readonly primary: PackageUnitSnapshot;
  readonly input: DistributionPackageInput;
  readonly assets: AssetRegistry;
  readonly issued: (asset: AssetRef) => boolean;
}): PackageUnitSnapshot {
  /** 当前 Platform identity 同时约束 primary 和最终 Unit。 */
  const platform = stableId(options.platform, 'Platform id');
  if (options.primary.platform !== platform || options.primary.role !== 'primary')
    throw new TypeError('Distribution primary must be the current Platform validated primary Unit.');
  /** Distribution 输入只有 id/type/assets 三个字段。 */
  const fields = dataObjectFields(options.input, new Set(['id', 'type', 'assets']), 'Distribution Package');
  /** Distribution ID 决定最终两级输出 root。 */
  const id = stableId(fields.id?.value, 'Distribution Package id');
  if (fields.type?.value !== 'marketplace')
    throw new TypeError('Distribution Package type must be marketplace.');
  /** primary Unit ID 与 Distribution ID 共用目标 Platform namespace。 */
  if (id === options.primary.id)
    throw new TypeError('Distribution Package id must differ from the primary Package id.');
  /** 只接受稠密的显式 asset mappings。 */
  const inputs = dataArrayItems(fields.assets?.value, 'Distribution Package assets') as readonly PackageAssetInput[];
  /** primaryRef identity 到继承 snapshot，不能按可伪造公开字段匹配。 */
  const inherited = new Map<AssetRef, PackageAssetSnapshot>();
  for (const asset of options.primary.assets)
    inherited.set(asset.asset, asset);
  /** 所有输出 path 在 Distribution 内共享完整冲突域。 */
  const paths = new Map<string, string>();
  /** snapshots 保留 inherited issuer owner。 */
  const snapshots: PackageAssetSnapshot[] = [];
  /** 新签发 ref 必须属于当前 Platform owner。 */
  const owner = `platform:${platform}`;
  for (const [index, input] of inputs.entries()) {
    /** 单个 mapping 不允许隐藏来源或 serializer 字段。 */
    const mapping = dataObjectFields(input, new Set(['path', 'asset']), `Distribution Package assets[${index}]`);
    /** path 与 ref 分别从已验证 descriptor 读取。 */
    const outputPath = reservePath(paths, mapping.path?.value);
    /** AssetRef 真实性只由后续 identity lookup 判断。 */
    const asset = mapping.asset?.value as AssetRef;
    /** inherited ref 可以重映射路径，但必须来自当前 primary 原始 identity。 */
    const primary = inherited.get(asset);
    if (primary !== undefined) {
      options.assets.describe(owner, asset);
      snapshots.push(Object.freeze({ path: outputPath, owner: primary.owner, asset }));
      continue;
    }
    /** 新增 ref 必须由当前 createDistributions callback scope 新签发。 */
    if (!options.issued(asset))
      throw new TypeError('Distribution Asset must be inherited from primary or issued during the current callback.');
    /** issued scope 通过后仍复核 Registry owner/session。 */
    const record = options.assets.describe(owner, asset);
    if (record.owner !== owner)
      throw new TypeError('Distribution callback additions must be issued by the current Platform.');
    snapshots.push(Object.freeze({ path: outputPath, owner, asset }));
  }
  return Object.freeze({
    platform,
    id,
    type: 'marketplace',
    role: 'distribution',
    assets: Object.freeze(snapshots.sort((left, right) => compareCodePoints(left.path, right.path))),
    compatibility: options.primary.compatibility,
    metadata: options.primary.metadata,
  });
}

/**
 * 在 Core 管理的一次性 Asset scope 内运行 Platform Distribution callback。
 *
 * @param options 当前 Platform、validated primary、Registry 与 callback。
 * @returns ID 唯一、稳定排序的 Distribution Units。
 */
export async function collectDistributionPackages(options: {
  readonly platform: string;
  readonly primary: PackageUnitSnapshot;
  readonly assets: AssetRegistry;
  readonly create: (assets: AssetService) => readonly DistributionPackageInput[] | Promise<readonly DistributionPackageInput[]>;
}): Promise<readonly PackageUnitSnapshot[]> {
  /** callback 只在 issuance scope active 期间获得 AssetService。 */
  const scope = options.assets.issuanceScope(`platform:${stableId(options.platform, 'Platform id')}`);
  /** outputs 在 finally 关闭 scope 前由 callback 完整返回。 */
  let outputs: readonly DistributionPackageInput[];
  try {
    outputs = await options.create(scope.service);
  } finally {
    scope.close();
  }
  /** callback 返回数组也必须是稠密 data array。 */
  const inputs = dataArrayItems(outputs, 'Distribution Packages') as readonly DistributionPackageInput[];
  /** 每个 output 独立通过 Distribution Registry 授权和路径校验。 */
  const units = inputs.map(input => createDistributionPackage({
    platform: options.platform,
    primary: options.primary,
    input,
    assets: options.assets,
    issued: scope.includes,
  }));
  /** 当前 Platform primary/distribution namespace 内的 Unit ID 必须唯一。 */
  if (new Set(units.map(unit => unit.id)).size !== units.length)
    throw new TypeError('Distribution Package ids must be unique.');
  return Object.freeze(units.sort((left, right) => compareCodePoints(left.id, right.id)));
}
