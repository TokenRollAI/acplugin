import { describe, expect, it } from 'vitest';
import { snapshotJson } from '../../src/api/integration.js';

describe('strict JSON snapshot boundary', () => {
  it('copies, orders and deeply freezes plain JSON without retaining input identity', () => {
    /** 调用方仍持有且将在 snapshot 后修改的输入。 */
    const input = { zebra: [{ enabled: true }], alpha: 1 };
    /** SDK 返回的隔离、稳定 snapshot。 */
    const snapshot = snapshotJson(input, 'Fixture');

    input.zebra[0]!.enabled = false;
    expect(snapshot).toEqual({ alpha: 1, zebra: [{ enabled: true }] });
    expect(Object.keys(snapshot as object)).toEqual(['alpha', 'zebra']);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen((snapshot as { readonly zebra: readonly unknown[] }).zebra)).toBe(true);
    expect(Object.isFrozen((snapshot as { readonly zebra: readonly object[] }).zebra[0])).toBe(true);
  });

  it('handles prototype-sensitive JSON keys without mutating the output prototype', () => {
    /** defineProperty 创建合法 JSON data property，避免对象字面量的 __proto__ 特殊语法。 */
    const input: Record<string, unknown> = { constructor: 'safe' };
    Object.defineProperty(input, '__proto__', {
      value: { polluted: true },
      enumerable: true,
      configurable: true,
      writable: true,
    });
    /** 普通对象输出必须把 __proto__ 保留为自有 data property。 */
    const snapshot = snapshotJson(input, 'Fixture') as Record<string, unknown>;

    expect(Object.getPrototypeOf(snapshot)).toBe(Object.prototype);
    expect(Object.hasOwn(snapshot, '__proto__')).toBe(true);
    expect(snapshot.__proto__).toEqual({ polluted: true });
    expect((Object.prototype as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('rejects executable, hidden and structurally ambiguous values without invoking getters', () => {
    /** getter 调用次数证明边界只读取 descriptor。 */
    let getterCalls = 0;
    /** accessor object 不得在诊断过程中执行 getter。 */
    const accessor = Object.defineProperty({}, 'secret', {
      get: () => {
        getterCalls += 1;
        return 'value';
      },
      enumerable: true,
    });
    /** non-enumerable 字段不能成为 JSON 中的隐藏语义。 */
    const hidden = Object.defineProperty({}, 'hidden', { value: true, enumerable: false });
    /** Symbol 字段不能绕过字符串字段快照。 */
    const symbol = Object.defineProperty({}, Symbol('hidden'), { value: true });
    /** 稀疏数组不能被隐式规范化成 null。 */
    const sparse = new Array(2);
    sparse[1] = 'value';
    /** 自定义 Array prototype 不属于无行为 JSON 容器。 */
    const inheritedArray: unknown[] = [];
    Object.setPrototypeOf(inheritedArray, Object.create(Array.prototype));

    expect(() => snapshotJson(accessor, 'Fixture')).toThrow('enumerable data property');
    expect(getterCalls).toBe(0);
    expect(() => snapshotJson(hidden, 'Fixture')).toThrow('enumerable data property');
    expect(() => snapshotJson(symbol, 'Fixture')).toThrow('Symbol');
    expect(() => snapshotJson(sparse, 'Fixture')).toThrow('sparse');
    expect(() => snapshotJson(inheritedArray, 'Fixture')).toThrow('plain array');
  });

  it('rejects cycles, unsupported primitives and non-finite numbers with stable paths', () => {
    /** 自引用对象验证 ancestor-based cycle detection。 */
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;

    expect(() => snapshotJson(cycle, 'Fixture')).toThrow('Fixture.self must not contain cycles');
    expect(() => snapshotJson({ nested: undefined }, 'Fixture')).toThrow('Fixture.nested must contain only JSON values');
    expect(() => snapshotJson({ nested: 1n }, 'Fixture')).toThrow('Fixture.nested must contain only JSON values');
    expect(() => snapshotJson({ nested: Number.NaN }, 'Fixture')).toThrow('Fixture.nested must contain only finite JSON numbers');
    expect(() => snapshotJson({}, '')).toThrow('label must be a non-empty string');
  });
});
