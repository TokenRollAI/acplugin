import type {
  CanonicalProject,
  NodeRuntimeResource,
  PublicResourceFile,
} from '../contracts/components.js';

/**
 * 将三个 Framework Provider 的独立结果组装为唯一 Project Graph。
 *
 * @param canonical 已验证 canonical Component graph。
 * @param publicFiles Public SourceAsset mappings。
 * @param runtime 可选内建 Runtime resource。
 * @returns 不含工程根或物理路径的不可变 Project。
 */
export function assembleProjectGraph(
  canonical: CanonicalProject,
  publicFiles: readonly PublicResourceFile[],
  runtime?: NodeRuntimeResource,
): CanonicalProject {
  return Object.freeze({
    metadata: canonical.metadata,
    commands: canonical.commands,
    skills: canonical.skills,
    agents: canonical.agents,
    publicFiles,
    ...(runtime === undefined ? {} : { runtime }),
  });
}
