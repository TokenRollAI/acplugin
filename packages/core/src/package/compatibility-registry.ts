import type {
  CanonicalProject,
  CompatibilityEntry,
  CompatibilityInput,
  CompatibilityLevel,
  MetadataDispositionEntry,
  MetadataDispositionInput,
  PluginMetadata,
} from '../kernel-types.js';
import { DiagnosticRegistry } from '../kernel/diagnostic-registry.js';
import { compareCodePoints, safeRelativePath } from '../kernel/path-policy.js';
import { sanitizeStableText } from '../kernel/report-safety.js';
import { snapshotJson } from './json-snapshot.js';

/** subject/capability/field/transformation/cause 使用的稳定结构化身份。 */
const STABLE_REFERENCE = /^[a-z0-9]+(?:[-.:/][a-z0-9]+)*$/u;

/** cause 使用的 `(subject)#(capability)` tuple key。 */
const TUPLE_REFERENCE = /^[a-z0-9]+(?:[-.:/][a-z0-9]+)*#[a-z0-9]+(?:[-.:/][a-z0-9]+)*$/u;

/** 规范 metadata 字段保留 camelCase，并可用点号表达 author 子字段。 */
const METADATA_FIELD = /^[A-Za-z][A-Za-z0-9]*(?:\.[A-Za-z][A-Za-z0-9]*)*$/u;

/** 兼容性等级从最好到最差的传播顺序。 */
const LEVEL_WEIGHT: Readonly<Record<CompatibilityLevel, number>> = Object.freeze({
  native: 0,
  transform: 1,
  degraded: 2,
  unsupported: 3,
});

/** @returns `(subject, capability)` 的无歧义稳定 cause key。 */
export function compatibilityTupleKey(subject: string, capability: string): string {
  return `${subject}#${capability}`;
}

/** @returns 当前 tuple entry 的稳定 cause key。 */
function entryKey(entry: Pick<CompatibilityInput, 'subject' | 'capability'>): string {
  return compatibilityTupleKey(entry.subject, entry.capability);
}

/**
 * 验证稳定的单行人类说明。
 *
 * @param value 未受信任 reason。
 * @param label 字段标签。
 * @returns 原始说明文本。
 */
function reason(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0)
    throw new TypeError(`${label} must be a non-empty stable single-line string.`);
  /** Compatibility/metadata reason 与 diagnostics 共用报告安全边界。 */
  const safe = sanitizeStableText(value);
  if (safe.length === 0)
    throw new TypeError(`${label} must not become empty after sanitization.`);
  return safe;
}

/**
 * 验证不承载任意日志文本的稳定身份。
 *
 * @param value 未知结构化引用。
 * @param label 字段标签。
 * @returns 合法原始文本。
 */
function stableReference(value: unknown, label: string): string {
  if (typeof value !== 'string' || !STABLE_REFERENCE.test(value))
    throw new TypeError(`${label} must be a stable lowercase reference.`);
  return value;
}

/** @returns 已验证且不承载路径语义的规范 metadata 字段。 */
function metadataField(value: unknown): string {
  if (typeof value !== 'string' || !METADATA_FIELD.test(value))
    throw new TypeError('Metadata field must be a stable field reference.');
  return value;
}

/** @returns compatibility cause 是否为稳定 tuple key。 */
function tupleReference(value: unknown): string {
  if (typeof value !== 'string' || !TUPLE_REFERENCE.test(value))
    throw new TypeError('Compatibility cause must be a stable subject#capability tuple key.');
  return value;
}

/**
 * 复制并验证单条 Platform 兼容性输入。
 *
 * @param platform Core 绑定的平台 ID。
 * @param input Integration 返回的输入。
 * @returns 绑定 Platform 且深度冻结的条目。
 */
export function snapshotCompatibility(platform: string, input: CompatibilityInput): CompatibilityEntry {
  /** 首先建立无行为 JSON snapshot，后续不再读取原始输入。 */
  const value = snapshotJson(input, 'Compatibility input');
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new TypeError('Compatibility input must be an object.');
  /** 未知字段不能隐式进入 report schema。 */
  const allowed = new Set(['subject', 'capability', 'level', 'transformation', 'reason', 'causes']);
  if (Object.keys(value).some(field => !allowed.has(field)))
    throw new TypeError('Compatibility input contains unknown fields.');
  /** 严格 JSON snapshot 已移除 getter、class、Symbol、cycle 与调用方 mutation。 */
  const snapshot = value as unknown as CompatibilityInput;
  if (!Object.hasOwn(LEVEL_WEIGHT, snapshot.level))
    throw new TypeError('Compatibility level is invalid.');
  /** causes 按结构化 tuple key 排序并拒绝重复。 */
  const causes = snapshot.causes?.map(tupleReference).sort(compareCodePoints);
  if (causes !== undefined && new Set(causes).size !== causes.length)
    throw new TypeError('Compatibility causes must not contain duplicates.');
  return Object.freeze({
    platform: stableReference(platform, 'Platform'),
    subject: stableReference(snapshot.subject, 'Compatibility subject'),
    capability: stableReference(snapshot.capability, 'Compatibility capability'),
    level: snapshot.level,
    ...(snapshot.transformation === undefined ? {} : { transformation: stableReference(snapshot.transformation, 'Compatibility transformation') }),
    reason: reason(snapshot.reason, 'Compatibility reason'),
    ...(causes === undefined ? {} : { causes: Object.freeze(causes) }),
  });
}

/**
 * 复制并验证一条 metadata disposition。
 *
 * @param platform Core 绑定的平台 ID。
 * @param input Platform 返回的输入。
 * @returns 绑定 Platform 且冻结的条目。
 */
export function snapshotMetadata(platform: string, input: MetadataDispositionInput): MetadataDispositionEntry {
  /** 首先建立无行为 JSON snapshot，后续不再读取原始输入。 */
  const value = snapshotJson(input, 'Metadata disposition');
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new TypeError('Metadata disposition must be an object.');
  /** disposition 只接受固定 report schema 字段。 */
  const allowed = new Set(['field', 'disposition', 'output', 'reason']);
  if (Object.keys(value).some(field => !allowed.has(field)))
    throw new TypeError('Metadata disposition contains unknown fields.');
  /** 后续字段只从无行为 JSON snapshot 读取。 */
  const snapshot = value as unknown as MetadataDispositionInput;
  if (snapshot.disposition !== 'emitted' && snapshot.disposition !== 'omitted')
    throw new TypeError('Metadata disposition is invalid.');
  /** output 可表达 package path 或稳定 Document field path。 */
  let output: string | undefined;
  if (snapshot.output !== undefined) {
    if (typeof snapshot.output !== 'string' || snapshot.output.length === 0
      || !/^[A-Za-z0-9@+._-]+(?:\/[A-Za-z0-9@+._-]+)*$/u.test(snapshot.output)) {
      throw new TypeError('Metadata output must be a stable package path or field path.');
    }
    safeRelativePath(snapshot.output);
    output = snapshot.output;
  }
  return Object.freeze({
    platform: stableReference(platform, 'Platform'),
    field: metadataField(snapshot.field),
    disposition: snapshot.disposition,
    ...(output === undefined ? {} : { output }),
    reason: reason(snapshot.reason, 'Metadata reason'),
  });
}

/** @returns 当前工程实际出现且必须被 Platform disposition 覆盖的 metadata 字段。 */
export function metadataFields(metadata: PluginMetadata): readonly string[] {
  /** 三个规范必填字段始终进入覆盖集合。 */
  const fields = ['name', 'version', 'description'];
  for (const field of ['displayName', 'homepage', 'repository', 'license'] as const) {
    if (metadata[field] !== undefined)
      fields.push(field);
  }
  if (metadata.author !== undefined) {
    fields.push('author.name');
    if (metadata.author.email !== undefined)
      fields.push('author.email');
    if (metadata.author.url !== undefined)
      fields.push('author.url');
  }
  if (metadata.keywords.length > 0)
    fields.push('keywords');
  return Object.freeze(fields.sort(compareCodePoints));
}

/** Component dependency 传播所需的稳定有向边。 */
interface CompatibilityDependency {
  readonly consumer: string;
  readonly dependency: string;
}

/** @returns Canonical Project 的 Component dependency edges。 */
function componentDependencies(project: CanonicalProject): readonly CompatibilityDependency[] {
  /** 三类 Component 统一为 subject identity。 */
  const components = [...project.commands, ...project.skills, ...project.agents];
  /** dependency edge 在返回前统一排序。 */
  const result: CompatibilityDependency[] = [];
  for (const component of components) {
    /** consumer 使用 canonical kind/id 组成稳定 subject。 */
    const consumer = `${component.kind}:${component.id}`;
    for (const id of component.requires.skills)
      result.push(Object.freeze({ consumer, dependency: `skill:${id}` }));
    for (const id of component.requires.agents)
      result.push(Object.freeze({ consumer, dependency: `agent:${id}` }));
  }
  return Object.freeze(result.sort((left, right) => compareCodePoints(left.consumer, right.consumer)
    || compareCodePoints(left.dependency, right.dependency)));
}

/** BuildSession 中集中执行覆盖、传播与最终 strictness 的兼容性 Registry。 */
export class CompatibilityRegistry {
  /** 当前 Project 用于 Component/metadata 完整覆盖。 */
  readonly #project: CanonicalProject;
  /** 最终诊断出口。 */
  readonly #diagnostics: DiagnosticRegistry;
  /** tuple key 到兼容性条目。 */
  readonly #compatibility = new Map<string, CompatibilityEntry>();
  /** platform+field 到 metadata 条目。 */
  readonly #metadata = new Map<string, MetadataDispositionEntry>();

  /** @param options 当前 Canonical Project 与统一诊断。 */
  constructor(options: { readonly project: CanonicalProject; readonly diagnostics: DiagnosticRegistry }) {
    this.#project = options.project;
    this.#diagnostics = options.diagnostics;
  }

  /**
   * 为一个 Platform 加入已验证 base/contribution compatibility。
   *
   * @param platform Platform ID。
   * @param inputs 任意完成顺序的输入集合。
   */
  addCompatibility(platform: string, inputs: readonly CompatibilityInput[]): void {
    for (const input of inputs) {
      /** 每条输入独立 snapshot 后才建立 tuple key。 */
      const entry = snapshotCompatibility(platform, input);
      /** Platform 与 tuple 共同组成 Registry 唯一键。 */
      const key = `${platform}:${entryKey(entry)}`;
      if (this.#compatibility.has(key))
        throw new TypeError(`Compatibility tuple "${key}" is duplicated.`);
      this.#compatibility.set(key, entry);
    }
  }

  /**
   * 为一个 Platform 加入 metadata dispositions。
   *
   * @param platform Platform ID。
   * @param inputs Platform base metadata 结论。
   */
  addMetadata(platform: string, inputs: readonly MetadataDispositionInput[]): void {
    for (const input of inputs) {
      /** 每条 disposition 独立 snapshot 后才建立字段键。 */
      const entry = snapshotMetadata(platform, input);
      /** Platform 与 metadata field 共同组成 Registry 唯一键。 */
      const key = `${platform}:${entry.field}`;
      if (this.#metadata.has(key))
        throw new TypeError(`Metadata disposition "${key}" is duplicated.`);
      this.#metadata.set(key, entry);
    }
  }

  /**
   * 验证覆盖、cause graph 和依赖传播，并执行一次最终 strictness。
   *
   * @param platforms 选中 Platform 与最终 strict 标记。
   * @returns 排序、冻结的兼容性和 metadata 报告集合。
   */
  finalize(platforms: readonly { readonly id: string; readonly strict: boolean }[]): {
    readonly compatibility: readonly CompatibilityEntry[];
    readonly metadata: readonly MetadataDispositionEntry[];
  } {
    /** 组件 subject 必须在每个平台恰好拥有 component tuple。 */
    const componentSubjects = [...this.#project.commands, ...this.#project.skills, ...this.#project.agents]
      .map(component => `${component.kind}:${component.id}`)
      .sort(compareCodePoints);
    /** metadata 只覆盖当前配置实际出现的字段。 */
    const expectedMetadata = metadataFields(this.#project.metadata);
    for (const platform of [...platforms].sort((left, right) => compareCodePoints(left.id, right.id))) {
      for (const subject of componentSubjects) {
        if (!this.#compatibility.has(`${platform.id}:${compatibilityTupleKey(subject, 'component')}`)) {
          this.#diagnostics.report('compatibility', {
            code: 'COMPATIBILITY_COMPONENT_MISSING', severity: 'error', message: `Platform "${platform.id}" did not report component compatibility for "${subject}".`,
          }, { platform: platform.id });
        }
      }
      /** 当前 Platform 实际提交的 metadata 字段集合。 */
      const actualFields = [...this.#metadata.values()].filter(entry => entry.platform === platform.id).map(entry => entry.field);
      for (const field of expectedMetadata) {
        if (!actualFields.includes(field)) {
          this.#diagnostics.report('compatibility', {
            code: 'METADATA_DISPOSITION_MISSING', severity: 'error', message: `Platform "${platform.id}" did not report metadata field "${field}".`,
          }, { platform: platform.id });
        }
      }
      for (const field of actualFields) {
        if (!expectedMetadata.includes(field)) {
          this.#diagnostics.report('compatibility', {
            code: 'METADATA_DISPOSITION_UNUSED', severity: 'error', message: `Platform "${platform.id}" reported absent metadata field "${field}".`,
          }, { platform: platform.id });
        }
      }
    }
    /** cause refs 必须存在于同一 Platform 且形成无环图。 */
    for (const entry of this.#compatibility.values()) {
      /** self 用于拒绝显式自引用。 */
      const self = entryKey(entry);
      for (const cause of entry.causes ?? []) {
        if (cause === self || !this.#compatibility.has(`${entry.platform}:${cause}`))
          throw new TypeError(`Compatibility cause "${cause}" is missing or self-referential.`);
      }
    }
    /** 对每个平台的显式 cause graph 执行 DFS 循环检测。 */
    for (const platform of platforms) {
      /** 当前平台 tuple key 到条目的局部索引。 */
      const entries = new Map([...this.#compatibility.values()]
        .filter(entry => entry.platform === platform.id)
        .map(entry => [entryKey(entry), entry]));
      /** visiting/visited 分别表示 DFS 灰色和黑色节点。 */
      const visiting = new Set<string>();
      /** 已完全验证的黑色节点无需重复遍历。 */
      const visited = new Set<string>();
      /** 单节点 cause DFS。 */
      const visit = (key: string): void => {
        if (visiting.has(key))
          throw new TypeError(`Compatibility causes contain a cycle at "${key}".`);
        if (visited.has(key))
          return;
        visiting.add(key);
        for (const cause of entries.get(key)?.causes ?? [])
          visit(cause);
        visiting.delete(key);
        visited.add(key);
      };
      for (const key of [...entries.keys()].sort(compareCodePoints))
        visit(key);
    }
    /** Component dependency 只传播 component capability 的最差等级。 */
    const dependencies = componentDependencies(this.#project);
    /** fixed-point 标记传播是否仍产生更差等级。 */
    let changed = true;
    while (changed) {
      changed = false;
      for (const platform of platforms) {
        for (const edge of dependencies) {
          /** consumer tuple 定位当前 Platform 的依赖方。 */
          const consumerKey = `${platform.id}:${compatibilityTupleKey(edge.consumer, 'component')}`;
          /** dependency tuple 定位当前 Platform 的被依赖方。 */
          const dependencyKey = `${platform.id}:${compatibilityTupleKey(edge.dependency, 'component')}`;
          /** consumer 缺失由覆盖诊断负责，不在传播阶段合成。 */
          const consumer = this.#compatibility.get(consumerKey);
          /** dependency 缺失同样不产生虚假传播条目。 */
          const dependency = this.#compatibility.get(dependencyKey);
          if (consumer === undefined || dependency === undefined || LEVEL_WEIGHT[dependency.level] <= LEVEL_WEIGHT[consumer.level])
            continue;
          /** 派生条目保留 consumer tuple 并加入依赖 cause。 */
          const cause = compatibilityTupleKey(edge.dependency, 'component');
          /** cause 集合去重排序后形成下一轮传播输入。 */
          const causes = [...new Set([...(consumer.causes ?? []), cause])].sort(compareCodePoints);
          this.#compatibility.set(consumerKey, Object.freeze({
            ...consumer,
            level: dependency.level,
            reason: `Dependency "${edge.dependency}" has ${dependency.level} compatibility.`,
            causes: Object.freeze(causes),
          }));
          changed = true;
        }
      }
    }
    /** strict enforcement 只观察最终传播完成的图。 */
    for (const platform of platforms) {
      for (const entry of this.#compatibility.values()) {
        if (entry.platform !== platform.id || (entry.level !== 'degraded' && entry.level !== 'unsupported'))
          continue;
        this.#diagnostics.report('compatibility', {
          code: platform.strict ? 'COMPATIBILITY_STRICT_FAILURE' : 'COMPATIBILITY_RELAXED',
          severity: platform.strict ? 'error' : 'warning',
          message: `Platform "${platform.id}" reports ${entry.level} for ${entry.subject}/${entry.capability}.`,
        }, { platform: platform.id });
      }
    }
    /** 最终数组使用明确 tuple 键排序。 */
    const compatibility = [...this.#compatibility.values()].sort((left, right) => compareCodePoints(left.platform, right.platform)
      || compareCodePoints(left.subject, right.subject) || compareCodePoints(left.capability, right.capability));
    /** metadata 报告按 Platform/field 固定排序。 */
    const metadata = [...this.#metadata.values()].sort((left, right) => compareCodePoints(left.platform, right.platform)
      || compareCodePoints(left.field, right.field));
    return Object.freeze({ compatibility: Object.freeze(compatibility), metadata: Object.freeze(metadata) });
  }
}
