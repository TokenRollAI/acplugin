import type { CompatibilityEntry, Diagnostic, DiagnosticCollectorLike, ResolvedTarget } from './types.js';

export function sanitizeReportText(value: string): string {
  return value
    .replace(/\b(?:Bearer|Basic)\s+[^\s,;]+/gi, '<redacted-credential>')
    .replace(/\b(?:token|secret|password|api[_-]?key)\s*[=:]\s*[^\s,;]+/gi, '<redacted-credential>')
    .replace(/(?:[A-Za-z]:[\\/]|\/)(?:[^\s"'`:,]|:(?!\/\/))+/g, '<path>')
    .replace(/[\r\n\t]+/g, ' ')
    .trim();
}

function safeLocation(location: import('./types.js').SourceLocation | undefined): import('./types.js').SourceLocation | undefined {
  if (!location)
    return undefined;
  const safePath = /^(?:[A-Za-z]:[\\/]|\/)/.test(location.path) ? '<path>' : location.path;
  return { ...location, path: safePath };
}

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

function compareStrings(a: string | undefined, b: string | undefined): number {
  return (a ?? '').localeCompare(b ?? '', 'en');
}

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

export class DiagnosticCollector implements DiagnosticCollectorLike {
  readonly #items: Diagnostic[] = [];

  get diagnostics(): readonly Diagnostic[] {
    return sortDiagnostics(this.#items);
  }

  get hasErrors(): boolean {
    return this.#items.some(item => item.severity === 'error');
  }

  add(diagnostic: Diagnostic): void {
    this.#items.push(safeDiagnostic(diagnostic));
  }

  error(
    code: string,
    message: string,
    options: Partial<Omit<Diagnostic, 'code' | 'message' | 'severity'>> = {},
  ): void {
    this.add({ code, message, severity: 'error', phase: options.phase ?? 'unknown', ...options });
  }

  warning(
    code: string,
    message: string,
    options: Partial<Omit<Diagnostic, 'code' | 'message' | 'severity'>> = {},
  ): void {
    this.add({ code, message, severity: 'warning', phase: options.phase ?? 'unknown', ...options });
  }
}

export function applyCompatibilityStrictness(
  collector: DiagnosticCollectorLike,
  target: ResolvedTarget,
  entries: readonly CompatibilityEntry[],
): void {
  for (const entry of entries) {
    if (entry.level !== 'degraded' && entry.level !== 'unsupported')
      continue;

    const message = `${entry.subject}: ${entry.reason}`;
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
