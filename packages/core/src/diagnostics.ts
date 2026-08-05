import type { CompatibilityEntry, Diagnostic, DiagnosticCollectorLike, ResolvedTarget } from './types.js';

/**
 * 清理即将写入诊断和兼容性报告的自由文本，避免泄露凭据与本机绝对路径。
 *
 * @param value Compiler、Module 或底层异常提供的原始文本。
 * @returns 去除敏感内容和控制空白后的单行文本。
 */
export function sanitizeReportText(value: string): string {
  return value
    .replace(/\b(?:Bearer|Basic)\s+[^\s,;]+/gi, '<redacted-credential>')
    .replace(/\b(?:token|secret|password|api[_-]?key)\s*[=:]\s*[^\s,;]+/gi, '<redacted-credential>')
    .replace(/(?:[A-Za-z]:[\\/]|\/)(?:[^\s"'`:,]|:(?!\/\/))+/g, '<path>')
    .replace(/[\r\n\t]+/g, ' ')
    .trim();
}

/**
 * 复制源码位置并隐藏绝对路径，同时保留安全的工程相对路径。
 *
 * @param location 原始源码位置。
 * @returns 可安全写入构建报告的位置；未提供位置时返回 undefined。
 */
function safeLocation(location: import('./types.js').SourceLocation | undefined): import('./types.js').SourceLocation | undefined {
  if (!location)
    return undefined;
  /** 对外报告使用的路径，绝对路径统一替换为占位符。 */
  const safePath = /^(?:[A-Za-z]:[\\/]|\/)/.test(location.path) ? '<path>' : location.path;
  return { ...location, path: safePath };
}

/**
 * 对单条诊断执行完整的报告安全处理，并修正不符合规范的诊断码。
 *
 * @param diagnostic 尚未进入 Collector 的诊断。
 * @returns 可安全持久化和展示的诊断副本。
 */
function safeDiagnostic(diagnostic: Diagnostic): Diagnostic {
  return {
    ...diagnostic,
    code: /^[A-Z][A-Z0-9_]*$/.test(diagnostic.code) ? diagnostic.code : 'DIAGNOSTIC_CODE_INVALID',
    message: sanitizeReportText(diagnostic.message),
    phase: sanitizeReportText(diagnostic.phase),
    ...(diagnostic.module === undefined ? {} : { module: sanitizeReportText(diagnostic.module) }),
    ...(diagnostic.component === undefined ? {} : { component: { ...diagnostic.component, id: sanitizeReportText(diagnostic.component.id) } }),
    ...(diagnostic.fieldPath === undefined ? {} : { fieldPath: diagnostic.fieldPath.map(field => typeof field === 'string' ? sanitizeReportText(field) : field) }),
    ...(diagnostic.hint === undefined ? {} : { hint: sanitizeReportText(diagnostic.hint) }),
    ...(diagnostic.location === undefined ? {} : { location: safeLocation(diagnostic.location)! }),
    ...(diagnostic.related === undefined ? {} : { related: diagnostic.related.map(location => safeLocation(location)!) }),
  };
}

/**
 * 对可选字符串执行稳定的英文区域排序比较。
 *
 * @param a 左侧可选字符串。
 * @param b 右侧可选字符串。
 * @returns 与 Array.sort 约定一致的比较结果。
 */
function compareStrings(a: string | undefined, b: string | undefined): number {
  return (a ?? '').localeCompare(b ?? '', 'en');
}

/**
 * 按目标、Module、源码位置和内容对诊断进行确定性排序。
 *
 * @param diagnostics 任意收集顺序的诊断列表。
 * @returns 不修改输入的稳定排序副本。
 */
export function sortDiagnostics(diagnostics: readonly Diagnostic[]): Diagnostic[] {
  return [...diagnostics].sort((a, b) =>
    compareStrings(a.target, b.target)
    || compareStrings(a.module, b.module)
    || compareStrings(a.location?.path, b.location?.path)
    || (a.location?.line ?? 0) - (b.location?.line ?? 0)
    || (a.location?.column ?? 0) - (b.location?.column ?? 0)
    || compareStrings(a.code, b.code)
    || compareStrings(a.message, b.message));
}

/**
 * 清理兼容性条目中的自由文本，并按平台与能力稳定排序。
 *
 * @param entries Compiler 或 Module 产生的兼容性说明。
 * @returns 可安全写入报告的排序副本。
 */
export function sortCompatibility(entries: readonly CompatibilityEntry[]): CompatibilityEntry[] {
  return entries.map(entry => ({
    ...entry,
    subject: sanitizeReportText(entry.subject),
    capability: sanitizeReportText(entry.capability),
    reason: sanitizeReportText(entry.reason),
    ...(entry.transformation === undefined ? {} : { transformation: sanitizeReportText(entry.transformation) }),
    ...(entry.causes === undefined ? {} : { causes: entry.causes.map(sanitizeReportText) }),
  })).sort((a, b) =>
    compareStrings(a.target, b.target)
    || compareStrings(a.subject, b.subject)
    || compareStrings(a.capability, b.capability)
    || compareStrings(a.level, b.level));
}

/**
 * 汇总一次构建生命周期内的诊断，并在写入时统一建立脱敏边界。
 */
export class DiagnosticCollector implements DiagnosticCollectorLike {
  /** 按产生顺序保存的安全诊断，读取时再执行确定性排序。 */
  readonly #items: Diagnostic[] = [];

  /**
   * 返回按确定规则排序的诊断快照。
   *
   * @returns 不暴露内部可变数组的只读列表。
   */
  get diagnostics(): readonly Diagnostic[] {
    return sortDiagnostics(this.#items);
  }

  /**
   * 指示当前构建是否已经产生至少一条错误级诊断。
   *
   * @returns 存在错误时返回 true。
   */
  get hasErrors(): boolean {
    return this.#items.some(item => item.severity === 'error');
  }

  /**
   * 清理并加入一条完整诊断。
   *
   * @param diagnostic 调用方构造的原始诊断。
   */
  add(diagnostic: Diagnostic): void {
    this.#items.push(safeDiagnostic(diagnostic));
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

/**
 * 根据目标的 strict 配置，把降级或不支持能力转换为错误或警告。
 *
 * 完全支持以及仅包含信息的条目不会阻塞构建；严格模式则会阻止任何能力损失。
 *
 * @param collector 当前构建共享的诊断收集器。
 * @param target 正在评估的目标平台配置。
 * @param entries 需要应用严格度策略的兼容性条目。
 */
export function applyCompatibilityStrictness(
  collector: DiagnosticCollectorLike,
  target: ResolvedTarget,
  entries: readonly CompatibilityEntry[],
): void {
  for (const entry of entries) {
    if (entry.level !== 'degraded' && entry.level !== 'unsupported')
      continue;

    /** 供终端和报告共同展示的兼容性摘要。 */
    const message = `${entry.subject}: ${entry.reason}`;
    /** 保留目标与阶段信息的诊断上下文。 */
    const options: Partial<Omit<Diagnostic, 'code' | 'message' | 'severity'>> = {
      phase: 'compatibility',
      target: target.id,
    };
    if (entry.transformation !== undefined)
      options.hint = entry.transformation;

    if (target.strict)
      collector.error('COMPATIBILITY_STRICT', message, options);
    else
      collector.warning('COMPATIBILITY_RELAXED', message, options);
  }
}
