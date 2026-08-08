import type {
  CompatibilityEntry,
  Diagnostic,
  DiagnosticCollectorLike,
  MetadataDispositionEntry,
} from './types.js';
import type { PlatformId } from './contracts.js';
import { compareCodeUnits } from './serialization.js';

/** 兼容性等级从完整保留到完全不支持的稳定排序权重。 */
const COMPATIBILITY_RANK = {
  native: 0,
  transform: 1,
  degraded: 2,
  unsupported: 3,
} as const;

/** 应按凭据处理、不能保留原值的对象字段名。 */
const SECRET_KEY_PATTERN = /(?:authorization|credential|password|secret|token|api[_-]?key|cookie)/i;

/** 报告深度脱敏时可额外提供的工程路径边界。 */
export interface ReportRedactionOptions {
  readonly roots?: readonly string[];
}

/** 描述一个 Component Subject 对其他 Subject 的依赖边。 */
export interface CompatibilityDependency {
  readonly subject: string;
  readonly dependsOn: readonly string[];
}

/**
 * 对可选字符串执行不依赖 locale 的稳定 code-unit 比较。
 *
 * @param a 左侧可选字符串。
 * @param b 右侧可选字符串。
 * @returns 与 Array.sort 约定一致的比较结果。
 */
function compareStrings(a: string | undefined, b: string | undefined): number {
  return compareCodeUnits(a ?? '', b ?? '');
}

/**
 * 清理即将写入诊断和报告的自由文本，避免泄露凭据与本机路径。
 *
 * @param value Platform、Extension 或底层异常提供的原始文本。
 * @param options 可选的工程路径边界。
 * @returns 去除敏感内容和控制空白后的单行文本。
 */
export function sanitizeReportText(value: string, options: ReportRedactionOptions = {}): string {
  /** 先清理通用凭据形式和 acplugin 临时目录名称的中间文本。 */
  let safe = value
    .replace(/\b(?:Bearer|Basic)\s+[^\s,;]+/gi, '<redacted-credential>')
    .replace(/\b(?:token|secret|password|api[_-]?key)\s*[=:]\s*[^\s,;]+/gi, '<redacted-credential>')
    .replace(/\.acplugin-(?:work|stage|backup|transaction|lock)-[^\s/\\]+/gi, '<redacted-temp>');
  for (const root of [...(options.roots ?? [])].sort((a, b) => b.length - a.length)) {
    if (root.length > 0)
      safe = safe.split(root).join('<path>');
  }
  return safe
    // 仅在字符串开头或非路径字符边界识别绝对路径，不能破坏 `assets/icon.png` 等协议相对路径。
    .replace(/(?<![A-Za-z0-9@._-])(?:[A-Za-z]:[\\/]|\/)(?:[^\s"'`:,]|:(?!\/\/))+/g, '<path>')
    .replace(/[\r\n\t]+/g, ' ')
    .trim();
}

/**
 * 递归清理任意未知值，阻止配置对象、函数、字节和循环引用进入 JSON 报告。
 *
 * @param value 尚未建立报告信任边界的任意值。
 * @param options 工程路径脱敏选项。
 * @param seen 当前递归路径已经访问的对象集合。
 * @returns 只包含安全 JSON 形态或稳定占位符的值。
 */
export function redactReportValue(
  value: unknown,
  options: ReportRedactionOptions = {},
  seen: WeakSet<object> = new WeakSet<object>(),
): unknown {
  if (typeof value === 'string')
    return sanitizeReportText(value, options);
  if (value === null || typeof value === 'boolean')
    return value;
  if (typeof value === 'number')
    return Number.isFinite(value) ? value : '<redacted-number>';
  if (typeof value === 'undefined' || typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint')
    return '<redacted-value>';
  if (value instanceof Uint8Array)
    return '<redacted-bytes>';
  if (seen.has(value))
    return '<redacted-circular>';
  seen.add(value);
  if (Array.isArray(value)) {
    /** 数组顺序属于报告语义，仅递归清理其元素。 */
    const result = value.map(item => redactReportValue(item, options, seen));
    seen.delete(value);
    return result;
  }
  /** 只允许普通对象进入报告，类实例、Map 和其他行为对象统一隐藏。 */
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    seen.delete(value);
    return '<redacted-object>';
  }
  /** 按原字段建立安全副本；最终 JSON serializer 会进一步稳定键顺序。 */
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    result[key] = SECRET_KEY_PATTERN.test(key)
      ? '<redacted-credential>'
      : redactReportValue(child, options, seen);
  }
  seen.delete(value);
  return result;
}

/**
 * 复制源码位置并隐藏绝对路径，同时保留安全的工程相对路径。
 *
 * @param location 原始源码位置。
 * @param options 工程路径脱敏选项。
 * @returns 可安全写入构建报告的位置；未提供位置时返回 undefined。
 */
function safeLocation(
  location: import('./types.js').SourceLocation | undefined,
  options: ReportRedactionOptions = {},
): import('./types.js').SourceLocation | undefined {
  if (!location)
    return undefined;
  /** 对外报告使用的路径，绝对路径统一替换为占位符。 */
  const safePath = /^(?:[A-Za-z]:[\\/]|\/)/.test(location.path) ? '<path>' : sanitizeReportText(location.path, options);
  return { ...location, path: safePath };
}

/**
 * 对单条诊断执行完整的报告安全处理，并修正不符合规范的诊断码。
 *
 * @param diagnostic 尚未进入 Collector 的诊断。
 * @param options 工程路径脱敏选项。
 * @returns 可安全持久化和展示的诊断副本。
 */
function safeDiagnostic(diagnostic: Diagnostic, options: ReportRedactionOptions = {}): Diagnostic {
  return {
    ...diagnostic,
    code: /^[A-Z][A-Z0-9_]*$/.test(diagnostic.code) ? diagnostic.code : 'DIAGNOSTIC_CODE_INVALID',
    message: sanitizeReportText(diagnostic.message, options),
    phase: sanitizeReportText(diagnostic.phase, options),
    ...(diagnostic.extension === undefined ? {} : { extension: sanitizeReportText(diagnostic.extension, options) }),
    ...(diagnostic.owner === undefined ? {} : { owner: sanitizeReportText(diagnostic.owner, options) }),
    ...(diagnostic.component === undefined ? {} : { component: { ...diagnostic.component, id: sanitizeReportText(diagnostic.component.id, options) } }),
    ...(diagnostic.fieldPath === undefined ? {} : { fieldPath: diagnostic.fieldPath.map(field => typeof field === 'string' ? sanitizeReportText(field, options) : field) }),
    ...(diagnostic.hint === undefined ? {} : { hint: sanitizeReportText(diagnostic.hint, options) }),
    ...(diagnostic.location === undefined ? {} : { location: safeLocation(diagnostic.location, options)! }),
    ...(diagnostic.related === undefined ? {} : { related: diagnostic.related.map(location => safeLocation(location, options)!) }),
  };
}

/**
 * 按 Platform、Extension、Owner、源码位置和内容对诊断进行确定性排序。
 *
 * @param diagnostics 任意收集顺序的诊断列表。
 * @param options 工程路径脱敏选项。
 * @returns 不修改输入的稳定排序副本。
 */
export function sortDiagnostics(
  diagnostics: readonly Diagnostic[],
  options: ReportRedactionOptions = {},
): Diagnostic[] {
  return diagnostics.map(diagnostic => safeDiagnostic(diagnostic, options)).sort((a, b) =>
    compareStrings(a.platform, b.platform)
    || compareStrings(a.extension, b.extension)
    || compareStrings(a.owner, b.owner)
    || compareStrings(a.location?.path, b.location?.path)
    || (a.location?.line ?? 0) - (b.location?.line ?? 0)
    || (a.location?.column ?? 0) - (b.location?.column ?? 0)
    || compareStrings(a.code, b.code)
    || compareStrings(a.message, b.message));
}

/**
 * 清理兼容性条目中的自由文本，并按 Platform、Subject、能力与等级稳定排序。
 *
 * @param entries Platform 或 Adapter 产生的兼容性说明。
 * @param options 工程路径脱敏选项。
 * @returns 可安全写入报告的排序副本。
 */
export function sortCompatibility(
  entries: readonly CompatibilityEntry[],
  options: ReportRedactionOptions = {},
): CompatibilityEntry[] {
  return entries.map(entry => ({
    ...entry,
    subject: sanitizeReportText(entry.subject, options),
    capability: sanitizeReportText(entry.capability, options),
    reason: sanitizeReportText(entry.reason, options),
    ...(entry.transformation === undefined ? {} : { transformation: sanitizeReportText(entry.transformation, options) }),
    ...(entry.causes === undefined ? {} : { causes: entry.causes.map(cause => sanitizeReportText(cause, options)) }),
  })).sort((a, b) =>
    compareStrings(a.platform, b.platform)
    || compareStrings(a.subject, b.subject)
    || compareStrings(a.capability, b.capability)
    || COMPATIBILITY_RANK[a.level] - COMPATIBILITY_RANK[b.level]
    || compareStrings(a.reason, b.reason));
}

/**
 * 按 Platform、字段和处理结果稳定排序元数据去向。
 *
 * @param entries Platform 产生的元数据字段去向。
 * @param options 工程路径脱敏选项。
 * @returns 完成文本清理的稳定排序副本。
 */
export function sortMetadataDispositions(
  entries: readonly MetadataDispositionEntry[],
  options: ReportRedactionOptions = {},
): MetadataDispositionEntry[] {
  return entries.map(entry => ({
    ...entry,
    field: sanitizeReportText(entry.field, options),
    reason: sanitizeReportText(entry.reason, options),
    ...(entry.output === undefined ? {} : { output: sanitizeReportText(entry.output, options) }),
  })).sort((a, b) =>
    compareStrings(a.platform, b.platform)
    || compareStrings(a.field, b.field)
    || compareStrings(a.disposition, b.disposition));
}

/** 汇总一次构建生命周期内的诊断，并在写入时统一建立脱敏边界。 */
export class DiagnosticCollector implements DiagnosticCollectorLike {
  /** 按产生顺序保存的安全诊断，读取时再执行确定性排序。 */
  readonly #items: Diagnostic[] = [];
  /** 当前运行需要从程序化 BuildResult 中隐藏的工程路径。 */
  readonly #redaction: ReportRedactionOptions;

  /**
   * 创建诊断 Collector，并固定当前运行的报告脱敏边界。
   *
   * @param redaction 工程路径边界。
   */
  constructor(redaction: ReportRedactionOptions = {}) {
    this.#redaction = redaction;
  }

  /** @returns 不暴露内部可变数组的确定性诊断快照。 */
  get diagnostics(): readonly Diagnostic[] {
    return sortDiagnostics(this.#items);
  }

  /** @returns 存在至少一个结构、安全或兼容性错误时返回 true。 */
  get hasErrors(): boolean {
    return this.#items.some(item => item.severity === 'error');
  }

  /**
   * 清理并加入一条完整诊断。
   *
   * @param diagnostic 调用方构造的原始诊断。
   */
  add(diagnostic: Diagnostic): void {
    this.#items.push(safeDiagnostic(diagnostic, this.#redaction));
  }

  /**
   * 使用错误级别创建并加入诊断。
   *
   * @param code 稳定、可供工具识别的诊断码。
   * @param message 面向开发者的错误说明。
   * @param options 除级别、代码和消息外的上下文。
   */
  error(
    code: string,
    message: string,
    options: Partial<Omit<Diagnostic, 'code' | 'message' | 'severity'>> = {},
  ): void {
    this.add({ code, message, severity: 'error', phase: options.phase ?? 'unknown', ...options });
  }

  /**
   * 使用警告级别创建并加入诊断。
   *
   * @param code 稳定、可供工具识别的诊断码。
   * @param message 面向开发者的警告说明。
   * @param options 除级别、代码和消息外的上下文。
   */
  warning(
    code: string,
    message: string,
    options: Partial<Omit<Diagnostic, 'code' | 'message' | 'severity'>> = {},
  ): void {
    this.add({ code, message, severity: 'warning', phase: options.phase ?? 'unknown', ...options });
  }
}

/** 汇总、排序并传播 Platform 功能兼容性结论。 */
export class CompatibilityCollector {
  /** 尚未应用依赖传播的原始与派生兼容性条目。 */
  readonly #items: CompatibilityEntry[] = [];

  /** @returns 完成文本清理和确定性排序的兼容性快照。 */
  get entries(): readonly CompatibilityEntry[] {
    return sortCompatibility(this.#items);
  }

  /** @returns 尚未执行依赖传播的当前条目数量，可作为阶段 checkpoint。 */
  get size(): number {
    return this.#items.length;
  }

  /**
   * 加入一条 Platform 功能兼容性结论。
   *
   * @param entry Platform 或 Extension Adapter 产生的结论。
   */
  add(entry: CompatibilityEntry): void {
    this.#items.push(entry);
  }

  /**
   * 批量加入兼容性结论。
   *
   * @param entries 保持业务含义、不要求已排序的条目。
   */
  addAll(entries: readonly CompatibilityEntry[]): void {
    this.#items.push(...entries);
  }

  /**
   * 把依赖 Subject 的最差兼容性递归传播到使用方，并保留完整 cause chain。
   *
   * @param dependencies 已完成 Core 图校验的 Subject 依赖边。
   */
  propagateDependencies(dependencies: readonly CompatibilityDependency[]): void {
    /** Subject 到其直接依赖列表的稳定索引。 */
    const dependencyMap = new Map(dependencies.map(item => [item.subject, [...item.dependsOn].sort(compareStrings)]));
    /** 当前 Collector 中实际出现的 Platform 集合。 */
    const platforms = [...new Set(this.#items.map(item => item.platform))].sort(compareStrings);
    for (const platform of platforms) {
      /** 当前 Platform 下每个 Subject 已经报告的原始条目。 */
      const bySubject = new Map<string, CompatibilityEntry[]>();
      for (const entry of this.#items.filter(item => item.platform === platform)) {
        /** 当前 Subject 已有条目或首次创建的可写列表。 */
        const items = bySubject.get(entry.subject) ?? [];
        items.push(entry);
        bySubject.set(entry.subject, items);
      }
      /** 避免依赖闭包重复计算的最差结论缓存。 */
      const memo = new Map<string, CompatibilityEntry | undefined>();

      /**
       * 计算一个 Subject 把全部依赖计入后的最差兼容性。
       *
       * @param subject 当前求值的 Subject。
       * @param stack 防御性循环检测使用的递归路径。
       * @returns 原始或依赖传播产生的最差条目。
       */
      const worstFor = (subject: string, stack: ReadonlySet<string>): CompatibilityEntry | undefined => {
        if (memo.has(subject))
          return memo.get(subject);
        /** 当前 Subject 自身最差的原始条目。 */
        let worst = [...(bySubject.get(subject) ?? [])]
          .sort((a, b) => COMPATIBILITY_RANK[b.level] - COMPATIBILITY_RANK[a.level] || compareStrings(a.capability, b.capability))[0];
        if (stack.has(subject))
          return worst;
        /** 递归调用使用且不会修改父级路径的集合副本。 */
        const nextStack = new Set(stack).add(subject);
        for (const dependency of dependencyMap.get(subject) ?? []) {
          /** 直接依赖计入其自身依赖闭包后的最差结果。 */
          const cause = worstFor(dependency, nextStack);
          if (!cause || (worst && COMPATIBILITY_RANK[cause.level] <= COMPATIBILITY_RANK[worst.level]))
            continue;
          worst = {
            platform,
            subject,
            capability: `dependency:${dependency}`,
            level: cause.level,
            reason: `${subject} depends on ${dependency}, whose compatibility is ${cause.level}.`,
            causes: [dependency, ...(cause.causes ?? [])],
          };
        }
        memo.set(subject, worst);
        return worst;
      };

      for (const subject of [...dependencyMap.keys()].sort(compareStrings)) {
        /** 传播前该 Subject 自身已有的最差等级。 */
        const original = [...(bySubject.get(subject) ?? [])]
          .sort((a, b) => COMPATIBILITY_RANK[b.level] - COMPATIBILITY_RANK[a.level])[0];
        /** 传播完整依赖闭包后得到的最差条目。 */
        const propagated = worstFor(subject, new Set<string>());
        if (propagated && propagated.capability.startsWith('dependency:')
          && (!original || COMPATIBILITY_RANK[propagated.level] > COMPATIBILITY_RANK[original.level]))
          this.#items.push(propagated);
      }
    }
  }

  /**
   * 仅把 degraded/unsupported 按当前 Platform strictness 转换为诊断。
   *
   * @param collector 构建共享的诊断收集器。
   * @param platform 当前 Platform ID 与严格模式。
   * @param start 仅处理此条目下标之后结论的阶段 checkpoint。
   */
  applyStrictness(
    collector: DiagnosticCollectorLike,
    platform: { readonly id: string; readonly strict: boolean },
    start = 0,
  ): void {
    /** 当前阶段 checkpoint 之后属于指定 Platform 的兼容性结论。 */
    const entries = sortCompatibility(this.#items.slice(start)).filter(entry => entry.platform === platform.id);
    applyCompatibilityStrictness(collector, platform, entries);
  }
}

/** 汇总 Platform 元数据去向，并把 omitted 固定报告为字段级 warning。 */
export class MetadataDispositionCollector {
  /** 以 Platform 和字段为键保存的唯一元数据去向。 */
  readonly #items = new Map<string, MetadataDispositionEntry>();

  /** 构建共享的诊断出口，用于 omitted warning 和冲突 error。 */
  readonly #diagnostics: DiagnosticCollectorLike;

  /**
   * 创建元数据去向 Collector。
   *
   * @param diagnostics 构建共享的诊断 Collector。
   */
  constructor(diagnostics: DiagnosticCollectorLike) {
    this.#diagnostics = diagnostics;
  }

  /** @returns 按 Platform 和字段确定性排序的元数据去向。 */
  get entries(): readonly MetadataDispositionEntry[] {
    return sortMetadataDispositions([...this.#items.values()]);
  }

  /**
   * 加入一个字段去向；重复且冲突的结论属于 Platform 结构错误。
   *
   * @param entry Platform 对统一元数据字段的最终处理。
   */
  add(entry: MetadataDispositionEntry): void {
    /** 同一 Platform 下字段去向的唯一键。 */
    const key = `${entry.platform}\0${entry.field}`;
    /** 之前已经登记的字段去向。 */
    const existing = this.#items.get(key);
    if (existing) {
      if (existing.disposition !== entry.disposition || existing.output !== entry.output || existing.reason !== entry.reason) {
        this.#diagnostics.error('METADATA_DISPOSITION_CONFLICT', `Metadata field ${entry.field} has conflicting dispositions.`, {
          phase: 'metadata', platform: entry.platform, fieldPath: [entry.field],
        });
      }
      return;
    }
    this.#items.set(key, entry);
    if (entry.disposition === 'omitted') {
      this.#diagnostics.warning('METADATA_OMITTED', `Metadata field ${entry.field} is omitted: ${entry.reason}`, {
        phase: 'metadata', platform: entry.platform, fieldPath: [entry.field],
      });
    }
  }
}

/**
 * 根据 Platform strict 配置，把功能降级或不支持转换为错误或警告。
 *
 * @param collector 当前构建共享的诊断收集器。
 * @param platform 正在评估的平台 ID 与严格度。
 * @param entries 需要应用严格度策略的兼容性条目。
 */
export function applyCompatibilityStrictness(
  collector: DiagnosticCollectorLike,
  platform: { readonly id: string; readonly strict: boolean },
  entries: readonly CompatibilityEntry[],
): void {
  for (const entry of entries) {
    if (entry.level !== 'degraded' && entry.level !== 'unsupported')
      continue;
    /** 供终端和报告共同展示的兼容性摘要。 */
    const message = `${entry.subject}: ${entry.reason}`;
    /** 保留 Platform 与阶段信息的诊断上下文。 */
    const options: Partial<Omit<Diagnostic, 'code' | 'message' | 'severity'>> = {
      phase: 'compatibility',
      platform: entry.platform,
      ...(entry.transformation === undefined ? {} : { hint: entry.transformation }),
    };
    if (platform.strict)
      collector.error('COMPATIBILITY_STRICT', message, options);
    else
      collector.warning('COMPATIBILITY_RELAXED', message, options);
  }
}

/** 将已校验的内部字符串收窄为报告使用的 PlatformId。 */
export function internalPlatformId(value: string): PlatformId {
  return value as PlatformId;
}
