/** Platform 与 Extension 共同使用且在本轮重写中保持不变的生命周期 API 版本。 */
export const LIFECYCLE_API_VERSION = '1' as const;

/** 同步值或 PromiseLike 值。 */
export type Awaitable<T> = T | PromiseLike<T>;

/** JSON 标量。 */
export type JsonPrimitive = string | number | boolean | null;

/** 可由 Core 复制、验证并冻结的 JSON 对象。 */
export interface JsonObject {
  readonly [key: string]: JsonValue;
}

/** 可由 Core 确定性处理的 JSON 值。 */
export type JsonValue = JsonPrimitive | readonly JsonValue[] | JsonObject;

/** Document 中不可歧义的非空字段路径。 */
export type DocumentFieldPath = readonly [string, ...string[]];
