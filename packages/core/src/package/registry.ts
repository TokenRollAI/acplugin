import type { AssetRef } from '../contracts/services.js';
/** Core 集中拥有 Platform base Package 与 Contribution merge。 */
import type {
  CompatibilityInput,
  ContributedPackageComponent,
  MetadataDispositionInput,
  PackageComponentOrigin,
  PackageContribution,
  PlatformDeliveryType,
} from '../contracts/integrations.js';
import type { DocumentFieldPath, JsonObject, JsonValue } from '../contracts/common.js';
import type {
  MergedPackageSnapshot,
  PackageAssetInput,
  PackageAssetSnapshot,
  PackageDocumentInput,
  PackageDocumentSnapshot,
  PlatformFinalizationFieldContribution,
  PackageUnitSnapshot,
  PlatformBasePackageSnapshot,
  PlatformPackageInput,
  PrimaryPackageInput,
} from '../contracts/packages.js';
import { AssetRegistry } from '../services/assets.js';
import { dataArrayItems, dataObjectFields } from '../security/data-boundary.js';
import { snapshotJsonWithObjectGuard } from '../security/json-snapshot.js';
import { compareCodePoints, safeRelativePath, sourceCollisionKey } from '../security/path-policy.js';
import { snapshotCompatibility, snapshotMetadata } from './compatibility.js';
import { documentIsEmpty, encodePackageDocument } from './documents.js';
import {
  addDocumentField,
  documentFieldAvailable,
  documentFieldKey,
  snapshotFieldPath,
} from './json-snapshot.js';

/** Package、Document 与 Unit ID 共用的稳定标识规则。 */
const STABLE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

/** 无序 Contribution 的 owner-bound 内部输入。 */
export interface OwnedPackageContribution {
  readonly owner: string;
  readonly contribution: PackageContribution<JsonObject>;
  readonly subjects?: readonly { readonly subject: string; readonly capabilities: readonly string[] }[];
}

/**
 * 验证对象仅含允许的 data fields。
 *
 * @param value 未受信任对象。
 * @param allowed 精确字段集合。
 * @param label 诊断标签。
 * @returns 不执行 getter 的字段描述符。
 */
function fields(value: unknown, allowed: ReadonlySet<string>, label: string): Record<string, PropertyDescriptor> {
  return dataObjectFields(value, allowed, label);
}

/**
 * 复制 Package 层严格 JSON，并拒绝把当前 Session 的 capability identity 当成数据。
 *
 * SourceRef/AssetRef 只能通过专用 Package Asset mapping 传递；若进入 Document 或
 * opaque Component JSON，它们会退化成看似普通的 kind/id 对象并产出损坏配置。
 */
function snapshotPackageJson(value: unknown, label: string, assets: AssetRegistry): JsonValue {
  return snapshotJsonWithObjectGuard(value, label, (candidate, path) => {
    if (assets.isCapabilityReference(candidate))
      throw new TypeError(`${path} must not contain Core capability references.`);
  });
}

/** @returns 未知文本是否为规范 package/document ID。 */
function stableId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !STABLE_ID.test(value))
    throw new TypeError(`${label} must use lowercase kebab-case.`);
  return value;
}

/**
 * 在单个 Package namespace 内登记路径并拒绝 exact/case/NFC 碰撞。
 *
 * @param paths 已占用 collision key 到原始路径。
 * @param value 新路径候选。
 * @param label 路径角色。
 * @returns 验证后的 package-relative POSIX 路径。
 */
function reservePath(paths: Map<string, string>, value: unknown, label: string): string {
  /** 首先规范化并验证 package-relative POSIX path。 */
  const safe = safeRelativePath(value);
  /** collision key 同时折叠大小写与 Unicode 规范化。 */
  const key = sourceCollisionKey(safe);
  /** 已占用的原始路径用于稳定冲突诊断。 */
  const existing = paths.get(key);
  if (existing !== undefined)
    throw new TypeError(`${label} path "${safe}" collides with "${existing}".`);
  /** 文件路径不能同时充当另一个文件的祖先目录。 */
  for (const [reservedKey, reservedPath] of paths) {
    if (key.startsWith(`${reservedKey}/`) || reservedKey.startsWith(`${key}/`))
      throw new TypeError(`${label} path "${safe}" has a file/directory conflict with "${reservedPath}".`);
  }
  paths.set(key, safe);
  return safe;
}

/**
 * 复制并验证 Document extension points。
 *
 * @param value Document 当前值。
 * @param input 未受信任 paths。
 * @returns 唯一、排序且全部指向当前空位的 paths。
 */
function documentPoints(
  value: JsonValue,
  input: unknown,
  label: 'extension' | 'finalization',
): readonly DocumentFieldPath[] {
  /** 两类 point 都必须越过稠密 data array 边界。 */
  const items = dataArrayItems(input, `Document ${label}Points`);
  /** path key 到精确 tuple，用于拒绝重复声明。 */
  const paths = new Map<string, DocumentFieldPath>();
  for (const [index, candidate] of items.entries()) {
    /** 每条 path 复制为非空字段 tuple。 */
    const path = snapshotFieldPath(candidate, `Document ${label}Points[${index}]`);
    /** JSON tuple key 避免字段名中的分隔符产生歧义。 */
    const key = documentFieldKey(path);
    if (paths.has(key))
      throw new TypeError(`Document ${label} point ${key} is duplicated.`);
    if (!documentFieldAvailable(value, path))
      throw new TypeError(`Document ${label} point ${key} must target an exact empty field.`);
    paths.set(key, path);
  }
  return Object.freeze([...paths.values()].sort((left, right) => compareCodePoints(documentFieldKey(left), documentFieldKey(right))));
}

/**
 * 复制一个 Platform base Document。
 *
 * @param input Platform 返回的结构化 Document。
 * @param paths 与 base Asset 共享的输出路径索引。
 * @returns 冻结且可安全交给全部 Contributor 的 Document。
 */
function documentSnapshot(
  input: PackageDocumentInput,
  paths: Map<string, string>,
  assets: AssetRegistry,
): PackageDocumentSnapshot {
  /** Document 顶层只允许规范字段。 */
  const descriptor = fields(input, new Set(['id', 'path', 'format', 'value', 'emission', 'extensionPoints', 'finalizationPoints']), 'Package Document');
  /** Document ID 与路径分别建立逻辑和物理身份。 */
  const id = stableId(descriptor.id?.value, 'Document id');
  /** Document path 立即进入共享 Package collision domain。 */
  const documentPath = reservePath(paths, descriptor.path?.value, `Document "${id}"`);
  /** format 决定后续唯一 Core codec。 */
  const format = descriptor.format?.value;
  if (format !== 'json' && format !== 'yaml' && format !== 'toml' && format !== 'frontmatter')
    throw new TypeError(`Document "${id}" format is invalid.`);
  /** value 立即复制为不可变严格 JSON。 */
  const value = snapshotPackageJson(descriptor.value?.value, `Document ${id}`, assets);
  /** 未声明 emission 时 Document 必须生成。 */
  const emission = descriptor.emission?.value ?? 'required';
  if (emission !== 'required' && emission !== 'omit-if-empty')
    throw new TypeError(`Document "${id}" emission is invalid.`);
  /** 完整 snapshot 是 Contributor 唯一可见的 Document 形态。 */
  const extensions = documentPoints(value, descriptor.extensionPoints?.value, 'extension');
  const finalization = documentPoints(value, descriptor.finalizationPoints?.value ?? [], 'finalization');
  /** 两类点位都拥有同一 Document 空字段命名空间，禁止绕开 owner isolation。 */
  const extensionKeys = new Set(extensions.map(documentFieldKey));
  for (const point of finalization) {
    if (extensionKeys.has(documentFieldKey(point)))
      throw new TypeError(`Document finalization point ${documentFieldKey(point)} overlaps an extension point.`);
  }
  const snapshot = Object.freeze({
    id,
    path: documentPath,
    format,
    value,
    emission,
    extensionPoints: extensions,
    finalizationPoints: finalization,
  });
  /** codec 可表达性属于 base Package 边界，不能推迟到 finalization。 */
  encodePackageDocument(snapshot);
  return snapshot;
}

/**
 * 复制一条 owner-authorized Package Asset mapping。
 *
 * @param owner 当前 Platform、Extension 或 Framework owner。
 * @param input 未受信任 path/ref mapping。
 * @param assets 当前 BuildSession Asset Registry。
 * @param paths 当前 Package 路径索引。
 * @returns 保留真实 issuer owner 的冻结 snapshot。
 */
function assetSnapshot(
  owner: string,
  input: PackageAssetInput,
  assets: AssetRegistry,
  paths: Map<string, string>,
): PackageAssetSnapshot {
  /** Asset mapping 只允许 package path 和不透明 ref。 */
  const descriptor = fields(input, new Set(['path', 'asset']), 'Package Asset');
  /** Package path 在读取 Asset metadata 前先完成冲突检查。 */
  const assetPath = reservePath(paths, descriptor.path?.value, 'Asset');
  /** describe 同时验证 ref identity、owner grant 与 BuildSession。 */
  const asset = descriptor.asset?.value as AssetRef;
  /** record owner 是真实 issuer，不能由 Package owner 覆盖。 */
  const record = assets.describe(owner, asset);
  return Object.freeze({ path: assetPath, owner: record.owner, asset });
}

/**
 * 从 Platform createPackage 输出建立 immutable base Package。
 *
 * @param platform 当前 Platform ID。
 * @param input createPackage 原始输出。
 * @param assets 当前 Session Asset Registry。
 * @returns 所有 Contributor 共享的唯一 frozen base snapshot。
 */
export function createBasePackage(
  platform: string,
  input: PlatformPackageInput,
  assets: AssetRegistry,
): PlatformBasePackageSnapshot {
  /** Platform Package 顶层字段在任何数组元素执行前完成检查。 */
  const descriptor = fields(input, new Set(['documents', 'assets', 'compatibility', 'metadata']), 'Platform Package');
  /** 四组输入分别建立稠密数组边界。 */
  const documentInputs = dataArrayItems(descriptor.documents?.value, 'Platform Package documents') as readonly PackageDocumentInput[];
  /** Asset 输入不能通过自定义数组属性携带隐藏语义。 */
  const assetInputs = dataArrayItems(descriptor.assets?.value, 'Platform Package assets') as readonly PackageAssetInput[];
  /** compatibility 输入复制由专用 snapshot 完成。 */
  const compatibilityInputs = dataArrayItems(descriptor.compatibility?.value, 'Platform Package compatibility') as readonly CompatibilityInput[];
  /** metadata 输入复制由专用 snapshot 完成。 */
  const metadataInputs = dataArrayItems(descriptor.metadata?.value, 'Platform Package metadata') as readonly MetadataDispositionInput[];
  /** Platform owner 由调用上下文绑定。 */
  const owner = `platform:${stableId(platform, 'Platform id')}`;
  /** Document 和 Asset 共享同一个 package path collision domain。 */
  const paths = new Map<string, string>();
  /** Document map 顺序不进入最终 snapshot。 */
  const documents = documentInputs.map(document => documentSnapshot(document, paths, assets));
  if (new Set(documents.map(document => document.id)).size !== documents.length)
    throw new TypeError('Platform Package contains duplicate Document ids.');
  /** Base Assets 逐条校验 issuer/grant 并保留真实 owner。 */
  const mappedAssets = assetInputs.map((asset) => {
    /** Platform Package 消费的外部 issuer ref 显式获得后续继承授权。 */
    const snapshot = assetSnapshot(owner, asset, assets, paths);
    assets.grant(snapshot.owner, owner, snapshot.asset);
    return snapshot;
  });
  /** compatibility/metadata 在进入 base snapshot 时完成结构化验证但不绑定最终 report array。 */
  const compatibility = compatibilityInputs
    .map((entry) => {
      /** base snapshot 不重复保留当前已知 Platform ID。 */
      const { platform: _platform, ...snapshot } = snapshotCompatibility(platform, entry);
      return Object.freeze(snapshot);
    });
  /** metadata 使用与 compatibility 相同的去 Platform 身份 snapshot。 */
  const metadata = metadataInputs
    .map((entry) => {
      /** base snapshot 不重复保留当前已知 Platform ID。 */
      const { platform: _platform, ...snapshot } = snapshotMetadata(platform, entry);
      return Object.freeze(snapshot);
    });
  return Object.freeze({
    documents: Object.freeze(documents.sort((left, right) => compareCodePoints(left.id, right.id))),
    assets: Object.freeze(mappedAssets.sort((left, right) => compareCodePoints(left.path, right.path))),
    compatibility: Object.freeze(compatibility.sort((left, right) => compareCodePoints(left.subject, right.subject)
      || compareCodePoints(left.capability, right.capability))),
    metadata: Object.freeze(metadata.sort((left, right) => compareCodePoints(left.field, right.field))),
  });
}

/**
 * 校验 Contribution 对 validated subjects 的精确 compatibility 覆盖。
 *
 * @param owner Contribution owner。
 * @param compatibility 已验证输入。
 * @param subjects Extension validate 声明的覆盖合同。
 */
function validateSubjectCoverage(
  owner: string,
  compatibility: readonly CompatibilityInput[],
  subjects: OwnedPackageContribution['subjects'],
): void {
  if (subjects === undefined)
    return;
  /** 实际 tuple 集必须至少精确覆盖每个声明 tuple 一次。 */
  const actual = new Set(compatibility.map(entry => `${entry.subject}#${entry.capability}`));
  if (actual.size !== compatibility.length)
    throw new TypeError(`Contribution "${owner}" contains duplicate compatibility tuples.`);
  for (const subject of subjects) {
    for (const capability of subject.capabilities) {
      /** validate 声明的 tuple 必须由 Contribution 精确覆盖。 */
      const key = `${subject.subject}#${capability}`;
      if (!actual.has(key))
        throw new TypeError(`Contribution "${owner}" does not cover "${key}".`);
    }
  }
}

/** @returns Extension subject 是否使用其 validate 合同允许的稳定语法。 */
function componentSubject(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[a-z0-9]+(?:[-.:/][a-z0-9]+)*$/u.test(value))
    throw new TypeError(`${label} must be a stable lowercase identifier.`);
  return value;
}

/** 按 strict JSON snapshot 的稳定编码建立不会依赖输入数组顺序的排序键。 */
function componentValueKey(value: JsonObject): string {
  return JSON.stringify(value);
}

/**
 * 验证 finalization field 引用的 Component origins 属于当前 merged Package。
 *
 * object identity 是安全边界；metadata 同形、跨 Package/Session 的 origin 都不会
 * 命中这个 set。T02 的 AssetService 使用同一组 origin，因此 Document 与 Bytes
 * Asset 的 provenance 规则完全一致。
 */
function finalizationOrigins(
  value: unknown,
  components: readonly ContributedPackageComponent<JsonObject>[],
  label: string,
): readonly PackageComponentOrigin[] | undefined {
  if (value === undefined)
    return undefined;
  const inputs = dataArrayItems(value, `${label} componentOrigins`);
  const available = new Set(components.map(component => component.origin));
  const result = inputs.map((origin, index) => {
    if (typeof origin !== 'object' || origin === null || !available.has(origin as PackageComponentOrigin))
      throw new TypeError(`${label} componentOrigins[${index}] is not authorized for the current Package.`);
    return origin as PackageComponentOrigin;
  });
  /** 以 Core-signed identity 去重，避免同一 payload 多次出现时污染 provenance。 */
  return Object.freeze([...new Set(result)].sort((left, right) => compareCodePoints(left.owner, right.owner)
    || compareCodePoints(left.subject, right.subject)));
}

/**
 * 复制并验证一条 opaque Platform Component contribution。
 *
 * 该函数故意不读取 value 的字段；identity、schema、namespace 与 rendering 完全由
 * 对应 Platform 在 finalization 阶段拥有。
 */
function componentSnapshot(
  platform: string,
  assets: AssetRegistry,
  owner: string,
  input: unknown,
  subjects: OwnedPackageContribution['subjects'],
  index: number,
): ContributedPackageComponent<JsonObject> {
  if (subjects === undefined)
    throw new TypeError(`Contribution "${owner}" cannot provide Components without validated Extension subjects.`);
  const descriptor = fields(input, new Set(['subject', 'value']), `Contribution "${owner}" components[${index}]`);
  const subject = componentSubject(descriptor.subject?.value, 'Contribution Component subject');
  if (!subjects.some(candidate => candidate.subject === subject))
    throw new TypeError(`Contribution "${owner}" Component subject "${subject}" was not declared by Extension validation.`);
  const value = snapshotPackageJson(
    descriptor.value?.value,
    `Contribution ${owner} Component ${subject}`,
    assets,
  );
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new TypeError(`Contribution "${owner}" Component value must be a JSON object.`);
  return Object.freeze({
    value: value as JsonObject,
    origin: assets.issueComponentOrigin(platform, owner, subject),
  });
}

/**
 * 集中、无序地合并 Framework/Extension Contributions。
 *
 * @param platform 当前 Platform ID。
 * @param base 所有 Contributor 读取的同一 base snapshot。
 * @param contributions 任意配置或完成顺序的 owner-bound outputs。
 * @param assets 当前 Session Asset Registry。
 * @returns 与输入顺序无关的 immutable merged Package。
 */
export function mergePackageContributions(
  platform: string,
  base: PlatformBasePackageSnapshot,
  contributions: readonly OwnedPackageContribution[],
  assets: AssetRegistry,
): MergedPackageSnapshot<JsonObject> {
  stableId(platform, 'Platform id');
  /** owner 排序发生在任何 merge 前，确保错误与结果不受 completion order 影响。 */
  const ordered = [...contributions].sort((left, right) => compareCodePoints(left.owner, right.owner));
  if (new Set(ordered.map(item => item.owner)).size !== ordered.length)
    throw new TypeError('A Package can receive at most one Contribution from each owner.');
  /** base 路径与扩展点先投影到可变的 Core 私有合并状态。 */
  const paths = new Map<string, string>();
  for (const document of base.documents)
    reservePath(paths, document.path, `Document "${document.id}"`);
  for (const asset of base.assets)
    reservePath(paths, asset.path, 'Base Asset');
  /** Document ID 索引承载逐层 copy-on-write 的合并结果。 */
  const documents = new Map(base.documents.map(document => [document.id, document]));
  /** exact extension point 索引拒绝模糊或深合并语义。 */
  const points = new Map<string, { readonly document: string; readonly path: DocumentFieldPath }>();
  for (const document of base.documents) {
    for (const point of document.extensionPoints)
      points.set(`${document.id}:${documentFieldKey(point)}`, Object.freeze({ document: document.id, path: point }));
  }
  /** claims 防止两个 owner 同时占用相同 exact extension point。 */
  const claims = new Map<string, string>();
  /** Base Asset 已自动继承进入集中合并集合。 */
  const mappedAssets: PackageAssetSnapshot[] = [...base.assets];
  /** Base compatibility 与 Contribution tuple 共享碰撞域。 */
  const compatibility: CompatibilityInput[] = [...base.compatibility];
  /** Component payload 只在 merge 后、Platform finalization 前可见。 */
  const components: ContributedPackageComponent<JsonObject>[] = [];
  for (const item of ordered) {
    /** 单个 Contribution 只允许既有 add-only 输入和 opaque components envelope。 */
    const descriptor = fields(item.contribution, new Set(['components', 'documentFields', 'assets', 'compatibility']), `Contribution "${item.owner}"`);
    /** components 必须仍是 dense data array，内部只允许 subject/value JSON object。 */
    const rawComponents = dataArrayItems(descriptor.components?.value ?? [], `Contribution "${item.owner}" components`);
    /** 缺省 documentFields 等价于空 add-only 集合。 */
    const rawFields = dataArrayItems(descriptor.documentFields?.value ?? [], `Contribution "${item.owner}" documentFields`);
    /** 缺省 assets 等价于空 add-only 集合。 */
    const rawAssets = dataArrayItems(descriptor.assets?.value ?? [], `Contribution "${item.owner}" assets`);
    /** compatibility 是必填覆盖合同，不能缺省。 */
    const rawCompatibility = dataArrayItems(descriptor.compatibility?.value, `Contribution "${item.owner}" compatibility`);
    /** Compatibility 完成 snapshot 后再执行 subject coverage。 */
    const contributionCompatibility = (rawCompatibility as readonly CompatibilityInput[]).map((entry) => {
      /** merged snapshot 不重复保留当前已知 Platform ID。 */
      const { platform: _platform, ...snapshot } = snapshotCompatibility(platform, entry);
      return Object.freeze(snapshot);
    });
    validateSubjectCoverage(item.owner, contributionCompatibility, item.subjects);
    compatibility.push(...contributionCompatibility);
    for (const [index, raw] of rawComponents.entries())
      components.push(componentSnapshot(platform, assets, item.owner, raw, item.subjects, index));
    for (const [index, raw] of [...rawFields].entries()) {
      /** 单个字段贡献只能声明 document/path/value。 */
      const field = fields(raw, new Set(['document', 'path', 'value']), `Contribution "${item.owner}" documentFields[${index}]`);
      /** Document ID 必须命中 base 声明。 */
      const document = stableId(field.document?.value, 'Contribution Document id');
      /** 精确字段 tuple 与 base extension point 使用同一规范。 */
      const path = snapshotFieldPath(field.path?.value, 'Contribution Document field path');
      /** 合成无歧义 extension point lookup key。 */
      const key = `${document}:${documentFieldKey(path)}`;
      /** point 缺失表示 Platform 未公开该写入位置。 */
      const point = points.get(key);
      if (point === undefined)
        throw new TypeError(`Contribution "${item.owner}" targets undeclared extension point ${key}.`);
      /** claim owner 用于检测两个无序 Contributor 的竞争。 */
      const existingOwner = claims.get(key);
      if (existingOwner !== undefined)
        throw new TypeError(`Document extension point ${key} is claimed by both ${existingOwner} and ${item.owner}.`);
      /** current 始终是前一次 copy-on-write 的 frozen snapshot。 */
      const current = documents.get(document)!;
      /** addition 必须先复制成严格 JSON。 */
      const addition = snapshotPackageJson(field.value?.value, `Contribution ${item.owner} field ${key}`, assets);
      documents.set(document, Object.freeze({ ...current, value: addDocumentField(current.value, path, addition) }));
      claims.set(key, item.owner);
    }
    for (const asset of rawAssets as readonly PackageAssetInput[]) {
      /** Contribution 校验使用 contributor owner，随后授权目标 Platform 继承。 */
      const snapshot = assetSnapshot(item.owner, asset, assets, paths);
      assets.grant(snapshot.owner, `platform:${platform}`, snapshot.asset);
      mappedAssets.push(snapshot);
    }
  }
  /** duplicate compatibility tuple 不能由后写覆盖。 */
  const tuples = compatibility.map(entry => `${entry.subject}#${entry.capability}`);
  if (new Set(tuples).size !== tuples.length)
    throw new TypeError('Merged Package contains duplicate compatibility tuples.');
  return Object.freeze({
    documents: Object.freeze([...documents.values()].sort((left, right) => compareCodePoints(left.id, right.id))),
    assets: Object.freeze(mappedAssets.sort((left, right) => compareCodePoints(left.path, right.path))),
    compatibility: Object.freeze(compatibility.sort((left, right) => compareCodePoints(left.subject, right.subject)
      || compareCodePoints(left.capability, right.capability))),
    metadata: base.metadata,
    components: Object.freeze(components.sort((left, right) => compareCodePoints(left.origin.owner, right.origin.owner)
      || compareCodePoints(left.origin.subject, right.origin.subject)
      || compareCodePoints(componentValueKey(left.value), componentValueKey(right.value)))),
  });
}

/**
 * 将 Platform finalization fields 应用于 Platform 自己已预留的 Document 空字段。
 *
 * Extension merge 与 Platform finalization 是两个不可重叠的 add-only 命名空间；
 * 因此该步骤不能替换 Document、深合并或触及 extension point。
 */
function finalizeDocuments(
  documents: readonly PackageDocumentSnapshot[],
  input: readonly PlatformFinalizationFieldContribution[],
  components: readonly ContributedPackageComponent<JsonObject>[],
  assets: AssetRegistry,
): readonly PackageDocumentSnapshot[] {
  const result = new Map(documents.map(document => [document.id, document]));
  const points = new Map<string, { readonly document: string; readonly path: DocumentFieldPath }>();
  for (const document of documents) {
    for (const point of document.finalizationPoints)
      points.set(`${document.id}:${documentFieldKey(point)}`, Object.freeze({ document: document.id, path: point }));
  }
  const claims = new Set<string>();
  for (const [index, raw] of input.entries()) {
    const field = fields(raw, new Set(['document', 'path', 'value', 'componentOrigins']), `Primary Package documentFields[${index}]`);
    const document = stableId(field.document?.value, 'Primary Package Document id');
    const path = snapshotFieldPath(field.path?.value, 'Primary Package Document field path');
    const key = `${document}:${documentFieldKey(path)}`;
    if (!points.has(key))
      throw new TypeError(`Primary Package targets undeclared finalization point ${key}.`);
    if (claims.has(key))
      throw new TypeError(`Primary Package finalization point ${key} is duplicated.`);
    const current = result.get(document)!;
    const value = snapshotPackageJson(field.value?.value, `Primary Package field ${key}`, assets);
    const origins = finalizationOrigins(field.componentOrigins?.value, components, `Primary Package field ${key}`);
    /** 一个 Document 有任意 contribution-driven field 时保留其全部可信来源，供 codec Asset 继承。 */
    const mergedOrigins = origins === undefined
      ? current.componentOrigins
      : Object.freeze([...new Set([...(current.componentOrigins ?? []), ...origins])]
          .sort((left, right) => compareCodePoints(left.owner, right.owner) || compareCodePoints(left.subject, right.subject)));
    result.set(document, Object.freeze({
      ...current,
      value: addDocumentField(current.value, path, value),
      ...(mergedOrigins === undefined ? {} : { componentOrigins: mergedOrigins }),
    }));
    claims.add(key);
  }
  return Object.freeze([...result.values()].sort((left, right) => compareCodePoints(left.id, right.id)));
}

/**
 * 建立自动继承全部 Package 内容的 primary Unit snapshot。
 *
 * @param platform 当前 Platform ID。
 * @param deliveryType Platform definition 的交付类型。
 * @param merged 集中合并后的 Package snapshot。
 * @param input finalizePackage 返回值。
 * @param assets 当前 Session Asset Registry。
 * @returns 包含继承、finalize 与 Document bytes 的完整 primary Unit。
 */
export async function finalizePrimaryPackage(
  platform: string,
  deliveryType: PlatformDeliveryType,
  merged: MergedPackageSnapshot,
  input: PrimaryPackageInput,
  assets: AssetRegistry,
): Promise<PackageUnitSnapshot> {
  /** finalize 输出仍必须越过精确 data-object boundary。 */
  const descriptor = fields(input, new Set(['id', 'type', 'documentFields', 'assets']), 'Primary Package');
  /** Unit ID 是最终 transaction 根身份。 */
  const id = stableId(descriptor.id?.value, 'Primary Package id');
  if (descriptor.type?.value !== deliveryType)
    throw new TypeError(`Primary Package type must equal Platform delivery type "${deliveryType}".`);
  /** Platform owner 绑定 finalize 新增 Asset 的签发者。 */
  const owner = `platform:${stableId(platform, 'Platform id')}`;
  /** Platform 只能在当前 merged Package 已预留的 fields 上作一次 add-only finalization。 */
  const fieldsInput = dataArrayItems(descriptor.documentFields?.value ?? [], 'Primary Package documentFields') as readonly PlatformFinalizationFieldContribution[];
  const documents = finalizeDocuments(merged.documents, fieldsInput, merged.components, assets);
  /** primary 重新建立全量路径闭包。 */
  const paths = new Map<string, string>();
  /** merged Assets 自动继承，Platform 没有可遗漏的选择入口。 */
  const result: PackageAssetSnapshot[] = [];
  for (const inherited of merged.assets) {
    reservePath(paths, inherited.path, 'Inherited Asset');
    result.push(inherited);
  }
  /** finalize 可选新增 Asset 也必须使用稠密数组。 */
  const additions = dataArrayItems(descriptor.assets?.value ?? [], 'Primary Package assets');
  for (const addition of additions as readonly PackageAssetInput[]) {
    /** Platform addition 先验证 ref grant 与路径碰撞。 */
    const snapshot = assetSnapshot(owner, addition, assets, paths);
    if (snapshot.owner !== owner)
      throw new TypeError('Primary Package additions must be issued by the current Platform.');
    result.push(snapshot);
  }
  /** Core codec 产生的 bytes 使用 Platform owner 和结构化 Document provenance。 */
  for (const document of documents) {
    if (document.emission === 'omit-if-empty' && documentIsEmpty(document))
      continue;
    /** emitted Document 与所有继承 Asset 共用路径闭包。 */
    const path = reservePath(paths, document.path, `Document "${document.id}"`);
    /** Core codec bytes 使用结构化 document provenance 签发。 */
    const asset = await assets.issueFinalizationBytes(platform, owner, merged.components, {
      bytes: encodePackageDocument(document),
      origin: {
        operation: 'package-document',
        subjects: [`document:${document.id}`],
        ...(document.componentOrigins === undefined ? {} : { componentOrigins: document.componentOrigins }),
      },
    });
    result.push(Object.freeze({ path, owner, asset }));
  }
  return Object.freeze({
    platform,
    id,
    type: deliveryType,
    role: 'primary',
    assets: Object.freeze(result.sort((left, right) => compareCodePoints(left.path, right.path))),
    compatibility: merged.compatibility,
    metadata: merged.metadata,
  });
}
