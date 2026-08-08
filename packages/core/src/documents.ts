import { ArtifactRegistry, type ArtifactSourcePolicies } from './artifacts.js';
import { OutputPathRegistry } from './output-paths.js';
import type {
  DocumentAddPatch,
  DraftDocument,
  JsonObject,
  JsonValue,
  PlatformDraftInput,
  PlatformId,
} from './contracts.js';
import type { Artifact, ArtifactInput } from './types.js';

/** Document 逻辑 ID 使用的小写 kebab-case 规则。 */
const DOCUMENT_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Document Registry 内部保存的当前文档和可写扩展点。 */
interface DocumentRecord {
  readonly id: string;
  readonly path: string;
  readonly format: DraftDocument['format'];
  readonly owner: `platform:${string}`;
  readonly emission: NonNullable<DraftDocument['emission']>;
  value: JsonValue;
  readonly extensionPoints: ReadonlySet<string>;
  readonly extensionPointPaths: readonly (readonly string[])[];
  readonly fieldOwners: Map<string, string>;
}

/**
 * 递归复制并冻结 Platform 或 Extension 提供的 JSON 值。
 *
 * @param value 尚未进入 Core 所有权边界的候选值。
 * @param ancestors 当前递归链，用于拒绝循环对象。
 * @returns 与输入语义相同的不可变 JSON 快照。
 */
function cloneJson(value: JsonValue, ancestors: WeakSet<object> = new WeakSet<object>()): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean')
    return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value))
      throw new Error('Document values only support finite JSON numbers.');
    return value;
  }
  if (ancestors.has(value))
    throw new Error('Document values cannot contain circular references.');
  ancestors.add(value);
  if (Array.isArray(value)) {
    /** 数组顺序属于 Platform 文档语义。 */
    const result = Object.freeze(value.map(item => cloneJson(item, ancestors)));
    ancestors.delete(value);
    return result;
  }
  /** 按稳定键顺序复制的普通 JSON 对象。 */
  const object = value as JsonObject;
  /** 接收按键排序字段的不可变普通对象。 */
  const result: Record<string, JsonValue> = {};
  for (const key of Object.keys(object).sort((left, right) => left.localeCompare(right, 'en'))) {
    /** 当前字段的递归不可变快照。 */
    const child = cloneJson(object[key]!, ancestors);
    Object.defineProperty(result, key, { value: child, enumerable: true, configurable: false, writable: false });
  }
  ancestors.delete(value);
  return Object.freeze(result);
}

/**
 * 将字段路径转换为不会受字段内容歧义影响的内部键。
 *
 * @param fieldPath Document 字段路径。
 * @returns JSON 字符串形式的稳定路径键。
 */
function fieldKey(fieldPath: readonly string[]): string {
  return JSON.stringify(fieldPath);
}

/**
 * 查找字段路径的父对象并确认最终字段尚不存在。
 *
 * @param value 当前 Document 根值。
 * @param fieldPath 需要新增的字段路径。
 * @returns 父对象存在且最终字段为空位时返回 true。
 */
function isEmptyField(value: JsonValue, fieldPath: readonly string[]): boolean {
  /** 从根值逐层进入字段父对象的游标。 */
  let current: JsonValue = value;
  for (const segment of fieldPath.slice(0, -1)) {
    if (current === null || typeof current !== 'object' || Array.isArray(current) || !Object.hasOwn(current, segment))
      return false;
    current = (current as JsonObject)[segment]!;
  }
  if (current === null || typeof current !== 'object' || Array.isArray(current))
    return false;
  return !Object.hasOwn(current, fieldPath.at(-1)!);
}

/**
 * 在不可变 JSON 对象中新增一个此前不存在的字段。
 *
 * @param value 当前 Document 根值。
 * @param fieldPath 已验证为空位的字段路径。
 * @param addition Extension 提供的不可变新增值。
 * @returns 完成路径复制后的新 Document 根值。
 */
function addField(value: JsonValue, fieldPath: readonly string[], addition: JsonValue): JsonValue {
  /** 当前层必然是字段路径父链上的 JSON 对象。 */
  const object = value as JsonObject;
  /** 当前层需要进入或新增的字段名。 */
  const [head, ...tail] = fieldPath;
  /** 保持原字段并按键排序输出的新对象字段集合。 */
  const entries: [string, JsonValue][] = Object.entries(object).map(([key, child]) => [
    key,
    key === head && tail.length > 0 ? addField(child, tail, addition) : child,
  ]);
  if (tail.length === 0)
    entries.push([head!, addition]);
  /** 接收排序字段并逐项定义为只读属性的新 JSON 对象。 */
  const result: Record<string, JsonValue> = {};
  for (const [key, child] of entries.sort(([left], [right]) => left.localeCompare(right, 'en')))
    Object.defineProperty(result, key, { value: child, enumerable: true, configurable: false, writable: false });
  return Object.freeze(result);
}

/** 管理单个 Platform Draft 的逻辑 Document、扩展点和字段所有权。 */
export class DocumentRegistry {
  /** 当前 Platform 的固定 Document owner。 */
  readonly #platformOwner: `platform:${string}`;
  /** 按逻辑 ID 索引的可控内部 Document 记录。 */
  readonly #documents = new Map<string, DocumentRecord>();
  /** 与 Artifact Registry 共享的物理输出路径占用表。 */
  readonly #paths: OutputPathRegistry;

  /**
   * 接管 Platform prepare 阶段提供的初始 Document。
   *
   * @param platform 当前 Draft 所属的 Platform ID。
   * @param documents Platform 创建的初始文档列表。
   * @param paths 与 Artifact 共享的路径占用表。
   */
  constructor(platform: PlatformId, documents: readonly DraftDocument[], paths: OutputPathRegistry = new OutputPathRegistry()) {
    this.#platformOwner = `platform:${platform}`;
    this.#paths = paths;
    for (const document of documents)
      this.#addInitial(document);
  }

  /**
   * 校验并加入一个 Platform 初始 Document。
   *
   * @param document 尚未进入 Registry 的文档。
   */
  #addInitial(document: DraftDocument): void {
    if (!DOCUMENT_ID_PATTERN.test(document.id))
      throw new Error(`Document id "${document.id}" must use lowercase kebab-case.`);
    if (this.#documents.has(document.id))
      throw new Error(`Duplicate Document id "${document.id}".`);
    if (document.owner !== this.#platformOwner)
      throw new Error(`Document "${document.id}" must be owned by "${this.#platformOwner}".`);
    if (!['json', 'yaml', 'toml', 'frontmatter'].includes(document.format))
      throw new Error(`Document "${document.id}" has unsupported format.`);
    if (document.emission !== undefined && document.emission !== 'required' && document.emission !== 'omit-if-empty')
      throw new Error(`Document "${document.id}" has unsupported emission policy.`);
    /** 在普通 Artifact 加入前预留文档最终物理路径。 */
    const reservation = this.#paths.reserve(this.#platformOwner, 'document', document.path);
    /** Platform 初始值的 Core 所有不可变副本。 */
    const value = cloneJson(document.value);
    /** 去重后的精确 add-only 扩展点路径键。 */
    const extensionPoints = new Set<string>();
    /** 供最终 snapshot 保留语义路径的冻结副本。 */
    const extensionPointPaths: (readonly string[])[] = [];
    for (const fieldPath of document.extensionPoints) {
      if (fieldPath.length === 0 || fieldPath.some(segment => typeof segment !== 'string' || segment === ''))
        throw new Error(`Document "${document.id}" has an invalid extension point.`);
      /** 当前扩展点不可被 Platform 预先占值，否则会形成 replace 或 deep merge。 */
      const frozenPath = Object.freeze([...fieldPath]);
      /** 当前扩展点用于去重与所有权记录的稳定路径键。 */
      const key = fieldKey(frozenPath);
      if (extensionPoints.has(key))
        throw new Error(`Document "${document.id}" has a duplicate extension point.`);
      if (!isEmptyField(value, frozenPath))
        throw new Error(`Document "${document.id}" extension point ${key} must identify an empty field.`);
      extensionPoints.add(key);
      extensionPointPaths.push(frozenPath);
    }
    /** 内部记录允许更新 value 引用，但从不向外暴露本对象。 */
    this.#documents.set(document.id, {
      id: document.id,
      path: reservation.path,
      format: document.format,
      owner: this.#platformOwner,
      emission: document.emission ?? 'required',
      value,
      extensionPoints,
      extensionPointPaths: Object.freeze(extensionPointPaths),
      fieldOwners: new Map(),
    });
  }

  /**
   * 获取一个逻辑 Document 的只读当前值。
   *
   * @param id Platform 定义的稳定逻辑 ID。
   * @returns 完成此前 Extension patch 的不可变值。
   */
  getDocument<T = JsonValue>(id: string): Readonly<T> | undefined {
    return this.#documents.get(id)?.value as Readonly<T> | undefined;
  }

  /**
   * 让 Extension 在精确声明且尚为空的扩展点新增字段。
   *
   * @param owner `extension:<name>` 形式的字段所有者。
   * @param patch Adapter 提交的逻辑 Document patch。
   */
  patchDocument(owner: `extension:${string}`, patch: DocumentAddPatch): void {
    if (!owner.startsWith('extension:') || owner.length === 'extension:'.length)
      throw new Error('Document patch owner must identify an Extension.');
    /** Patch 指向的逻辑 Document。 */
    const document = this.#documents.get(patch.document);
    if (!document)
      throw new Error(`Unknown Document id "${patch.document}".`);
    /** Patch 路径的冻结副本和稳定所有权键。 */
    const patchPath = Object.freeze([...patch.path]);
    /** Patch 精确字段路径对应的所有权索引键。 */
    const key = fieldKey(patchPath);
    if (!document.extensionPoints.has(key))
      throw new Error(`Document "${patch.document}" does not declare extension point ${key}.`);
    /** 已占用同一扩展点的 Extension owner。 */
    const existingOwner = document.fieldOwners.get(key);
    if (existingOwner)
      throw new Error(`Document field ${key} is already owned by "${existingOwner}".`);
    if (!isEmptyField(document.value, patchPath))
      throw new Error(`Document field ${key} cannot be replaced or merged.`);
    /** Extension 值进入文档前由 Core 复制并冻结。 */
    const addition = cloneJson(patch.value);
    document.value = addField(document.value, patchPath, addition);
    document.fieldOwners.set(key, owner);
  }

  /** @returns 按逻辑 ID 排序且完全不可变的 Document 快照。 */
  snapshot(): readonly DraftDocument[] {
    return Object.freeze([...this.#documents.values()]
      .sort((left, right) => left.id.localeCompare(right.id, 'en'))
      .map(document => Object.freeze({
        id: document.id,
        path: document.path,
        format: document.format,
        owner: document.owner,
        emission: document.emission,
        value: document.value,
        extensionPoints: document.extensionPointPaths,
      })));
  }
}

/** 同时管理一个 Platform 的结构化 Document 与普通 Draft Artifact。 */
export class PlatformDraftRegistry {
  /** 当前 Draft 的 Platform owner。 */
  readonly #platformOwner: `platform:${string}`;
  /** 结构化 Document Registry。 */
  readonly #documents: DocumentRegistry;
  /** 与 Document 共享路径表的 Artifact Registry。 */
  readonly #artifacts: ArtifactRegistry;

  /**
   * 创建空 Registry；调用方应使用异步 create 完成初始 Artifact 接管。
   *
   * @param platform 当前 Platform ID。
   * @param documents 初始 Document。
   * @param sourcePolicies 按 Platform、Extension 与 Public owner 隔离的文件来源授权。
   * @param paths Document 与 Artifact 共享的路径表。
   */
  private constructor(
    platform: PlatformId,
    documents: readonly DraftDocument[],
    sourcePolicies: ArtifactSourcePolicies,
    paths: OutputPathRegistry,
  ) {
    this.#platformOwner = `platform:${platform}`;
    this.#documents = new DocumentRegistry(platform, documents, paths);
    this.#artifacts = new ArtifactRegistry(sourcePolicies, paths);
  }

  /**
   * 接管 Platform prepare 返回的完整初始 Draft。
   *
   * @param platform 当前 Platform ID。
   * @param input Platform Draft 输入。
   * @param sourcePolicies 文件型 Artifact 按 owner 隔离的来源授权。
   * @returns 完成 Document 与 Artifact 校验的 Registry。
   */
  static async create(
    platform: PlatformId,
    input: PlatformDraftInput,
    sourcePolicies: ArtifactSourcePolicies,
  ): Promise<PlatformDraftRegistry> {
    /** 当前 Draft 内所有物理文件共享的路径占用表。 */
    const paths = new OutputPathRegistry();
    /** 初始文档已经占用路径的 Registry。 */
    const registry = new PlatformDraftRegistry(platform, input.documents, sourcePolicies, paths);
    for (const artifact of input.artifacts)
      await registry.#artifacts.add(registry.#platformOwner, artifact);
    return registry;
  }

  /** 按逻辑 ID 读取完成此前 Adapter patch 的不可变 Document 值。 */
  getDocument<T = JsonValue>(id: string): Readonly<T> | undefined {
    return this.#documents.getDocument<T>(id);
  }

  /** 让指定 Extension owner 在精确声明的空扩展点新增字段。 */
  patchDocument(owner: `extension:${string}`, patch: DocumentAddPatch): void {
    this.#documents.patchDocument(owner, patch);
  }

  /**
   * 加入 Extension Adapter 产生的普通 Artifact。
   *
   * @param owner `extension:<name>` 形式的 Artifact owner。
   * @param input Adapter 提交的 Artifact。
   * @returns 完成 hash 与路径校验的 Artifact。
   */
  async emitArtifact(owner: `extension:${string}`, input: ArtifactInput): Promise<Artifact> {
    if (!owner.startsWith('extension:') || owner.length === 'extension:'.length)
      throw new Error('Adapter Artifact owner must identify an Extension.');
    return this.#artifacts.add(owner, input);
  }

  /**
   * 注入由 Core Scanner 验证的 Public 文件。
   *
   * @param input Public 文件对应的 file-source Artifact。
   * @returns owner 固定为 public 的已验证 Artifact。
   */
  async injectPublicArtifact(input: ArtifactInput): Promise<Artifact> {
    return this.#artifacts.add('public', input);
  }

  /** @returns 完成所有 add-only patch 后的只读文档快照。 */
  get documents(): readonly DraftDocument[] {
    return this.#documents.snapshot();
  }

  /** @returns Platform 与 Extension 共同产生的只读 Artifact 快照。 */
  get artifacts(): readonly Artifact[] {
    return this.#artifacts.artifacts;
  }
}
