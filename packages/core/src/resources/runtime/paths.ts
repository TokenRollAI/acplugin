/** Runtime entry ID 与其他 Core 稳定资源 ID 使用相同 lowercase-kebab 规则。 */
const RUNTIME_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

/** 验证公开路径 helper 不会把任意文本变成 Package 路径。 */
function runtimeId(id: string): string {
  if (typeof id !== 'string' || !RUNTIME_ID.test(id))
    throw new TypeError('Runtime entry id must use lowercase kebab-case.');
  return id;
}

/** 返回 Runtime entry 在所有支持 Platform 中的固定主 Bundle 路径。 */
export function nodeRuntimeArtifactPath(id: string): `runtime/${string}/main.mjs` {
  return `runtime/${runtimeId(id)}/main.mjs`;
}

/** 返回 Runtime entry 存在第三方依赖时使用的固定许可证路径。 */
export function nodeRuntimeLicensesArtifactPath(id: string): `runtime/${string}/THIRD_PARTY_LICENSES.txt` {
  return `runtime/${runtimeId(id)}/THIRD_PARTY_LICENSES.txt`;
}
