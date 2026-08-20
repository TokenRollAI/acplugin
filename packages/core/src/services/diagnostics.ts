import type {
  Diagnostic,
  DiagnosticPhase,
} from '../contracts/reports.js';
import type {
  DiagnosticInput,
  DiagnosticService,
} from '../contracts/services.js';
import { compareCodePoints, safeRelativePath } from '../security/path-policy.js';
import { sanitizeStableText } from '../security/report-safety.js';

/**
 * 比较可选稳定文本。
 *
 * @param left 左侧值。
 * @param right 右侧值。
 * @returns code-point 排序结果。
 */
function compareOptional(left: string | undefined, right: string | undefined): number {
  return compareCodePoints(left ?? '', right ?? '');
}

/**
 * 校验并复制 Integration 可提交的诊断。
 *
 * @param input 未受信任的诊断输入。
 * @returns 不含绝对路径和未知字段的冻结快照。
 */
function diagnosticInput(input: DiagnosticInput): DiagnosticInput {
  if (typeof input !== 'object' || input === null || Array.isArray(input))
    throw new TypeError('Diagnostic input must be an object.');
  /** SDK 诊断允许出现的完整字段集合。 */
  const allowed = new Set(['code', 'severity', 'message', 'location', 'fieldPath', 'hint']);
  if (Object.keys(input).some(field => !allowed.has(field)))
    throw new TypeError('Diagnostic input contains unknown fields.');
  if (!/^[A-Z][A-Z0-9_]*$/.test(input.code)
    || (input.severity !== 'warning' && input.severity !== 'error')
    || typeof input.message !== 'string' || input.message.length === 0) {
    throw new TypeError('Diagnostic code, severity or message is invalid.');
  }
  /** 自由文本在进入稳定集合前移除凭据、绝对路径和控制字符。 */
  const message = sanitizeStableText(input.message);
  if (message.length === 0)
    throw new TypeError('Diagnostic message must not become empty after sanitization.');
  /** 可选来源位置只能使用安全工程相对路径。 */
  const location = input.location === undefined
    ? undefined
    : Object.freeze({
        path: safeRelativePath(input.location.path),
        ...(input.location.line === undefined ? {} : { line: input.location.line }),
        ...(input.location.column === undefined ? {} : { column: input.location.column }),
      });
  if (location !== undefined
    && ((location.line !== undefined && (!Number.isSafeInteger(location.line) || location.line <= 0))
      || (location.column !== undefined && (!Number.isSafeInteger(location.column) || location.column <= 0)))) {
    throw new TypeError('Diagnostic location coordinates are invalid.');
  }
  /** 字段路径复制后不再受调用方 mutation 影响。 */
  const fieldPath = input.fieldPath === undefined ? undefined : Object.freeze([...input.fieldPath]);
  if (fieldPath?.some(field => (typeof field !== 'string' && typeof field !== 'number')
    || (typeof field === 'number' && (!Number.isSafeInteger(field) || field < 0)))) {
    throw new TypeError('Diagnostic fieldPath is invalid.');
  }
  if (input.hint !== undefined && (typeof input.hint !== 'string' || input.hint.length === 0))
    throw new TypeError('Diagnostic hint is invalid.');
  /** hint 使用与 message 相同的稳定脱敏边界。 */
  const hint = input.hint === undefined ? undefined : sanitizeStableText(input.hint);
  if (hint !== undefined && hint.length === 0)
    throw new TypeError('Diagnostic hint must not become empty after sanitization.');
  return Object.freeze({
    code: input.code,
    severity: input.severity,
    message,
    ...(location === undefined ? {} : { location }),
    ...(fieldPath === undefined ? {} : { fieldPath }),
    ...(hint === undefined ? {} : { hint }),
  });
}

/** BuildSession 内统一绑定 phase/owner 的诊断 Registry。 */
export class DiagnosticRegistry {
  /** 尚未排序的内部诊断集合。 */
  readonly #items: Diagnostic[] = [];

  /** @returns 当前是否已经存在阻止构建的错误。 */
  get hasErrors(): boolean {
    return this.#items.some(item => item.severity === 'error');
  }

  /** @returns 脱离内部数组且稳定排序的冻结诊断快照。 */
  get diagnostics(): readonly Diagnostic[] {
    return Object.freeze([...this.#items].sort((left, right) =>
      compareOptional(left.platform, right.platform)
      || compareOptional(left.extension, right.extension)
      || compareOptional(left.owner, right.owner)
      || compareOptional(left.location?.path, right.location?.path)
      || (left.location?.line ?? 0) - (right.location?.line ?? 0)
      || compareCodePoints(left.code, right.code)
      || compareCodePoints(left.message, right.message)));
  }

  /**
   * 由 Core 自己提交已经绑定身份的诊断。
   *
   * @param phase 固定生命周期阶段。
   * @param input 公开诊断字段。
   * @param identity 可选 owner/platform/extension/component 身份。
   */
  report(
    phase: DiagnosticPhase,
    input: DiagnosticInput,
    identity: Pick<Diagnostic, 'owner' | 'platform' | 'extension' | 'component' | 'related'> = {},
  ): void {
    /** 所有公开字段在进入可排序集合前建立数据边界。 */
    const normalized = diagnosticInput(input);
    /** related locations 也必须逐项通过 project-relative path 边界。 */
    const related = identity.related?.map((location) => {
      /** 重用公开 Diagnostic location 校验以保持坐标规则一致。 */
      const validated = diagnosticInput({ code: 'RELATED_LOCATION', severity: 'error', message: 'Related location.', location }).location!;
      return validated;
    });
    /** Core identity 字段从调用者闭包传入而不是从 SDK input 读取。 */
    this.#items.push(Object.freeze({
      ...normalized,
      phase,
      ...(identity.owner === undefined ? {} : { owner: identity.owner }),
      ...(identity.platform === undefined ? {} : { platform: identity.platform }),
      ...(identity.extension === undefined ? {} : { extension: identity.extension }),
      ...(identity.component === undefined ? {} : { component: Object.freeze({ ...identity.component }) }),
      ...(related === undefined ? {} : { related: Object.freeze(related) }),
    }));
  }

  /**
   * 创建不允许调用方覆盖 phase/owner 的闭包服务。
   *
   * @param phase 当前固定阶段。
   * @param identity 当前 owner/platform/extension 身份。
   * @returns 冻结 DiagnosticService。
   */
  service(
    phase: DiagnosticPhase,
    identity: Pick<Diagnostic, 'owner' | 'platform' | 'extension' | 'component'> = {},
  ): DiagnosticService {
    return Object.freeze({
      /** 调用方只能提交公开字段，phase 与身份由闭包固定。 */
      report: (input: DiagnosticInput) => this.report(phase, input, identity),
    });
  }
}
