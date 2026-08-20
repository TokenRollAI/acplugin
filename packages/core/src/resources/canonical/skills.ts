import type { SkillComponent } from '../../contracts/components.js';
import type { SourceAssetRef, SourceDirectoryRef, SourceFileRef } from '../../contracts/services.js';
import { AssetRegistry } from '../../services/assets.js';
import { DiagnosticRegistry } from '../../services/diagnostics.js';
import { compareCodePoints, safeRelativePath } from '../../security/path-policy.js';
import { SourceRegistry } from '../../services/sources.js';
import { componentId, error, fields, parseMarkdown, platforms, requires, rootEntries, stringField } from './shared.js';

/**
 * 扫描 Skill root 和辅助资源。
 *
 * @param root 可选 skills root。
 * @param sources canonical Source Service。
 * @param assets canonical Asset Service。
 * @param configured 配置 Platform IDs。
 * @param diagnostics 当前诊断集合。
 * @returns 有效 Skills。
 */
export async function discoverSkills(
  root: SourceDirectoryRef | undefined,
  sources: ReturnType<SourceRegistry['service']>,
  assets: ReturnType<AssetRegistry['service']>,
  configured: ReadonlySet<string>,
  diagnostics: DiagnosticRegistry,
): Promise<readonly SkillComponent[]> {
  /** Skill 结果在所有辅助资源完成签发后统一冻结。 */
  const result: SkillComponent[] = [];
  for (const entry of await rootEntries(root, sources)) {
    if (entry.type !== 'directory') {
      error(diagnostics, 'SKILL_ENTRY_INVALID', 'Skills must be one-level directories.', entry.path);
      continue;
    }
    if (!componentId(entry.name, entry.path, diagnostics))
      continue;
    /** 每个 Skill 必须拥有精确名称的主 Markdown 文件。 */
    let skillFile: SourceFileRef;
    try {
      skillFile = await sources.file(entry.directory, 'SKILL.md');
    } catch {
      error(diagnostics, 'SKILL_FILE_REQUIRED', 'Skill directory must contain SKILL.md.', entry.path);
      continue;
    }
    /** Skill 主文件沿用 canonical Markdown 解析边界。 */
    const markdown = await parseMarkdown(sources, skillFile, diagnostics);
    if (markdown === undefined)
      continue;
    fields(markdown.data, ['description', 'invocation', 'requires', 'platforms'], skillFile.path, diagnostics);
    /** description 缺失时不能产生不完整 Skill。 */
    const description = stringField(markdown.data, 'description', skillFile.path, diagnostics, true);
    if (description === undefined)
      continue;
    /** Skill 默认允许用户显式调用。 */
    let user = true;
    /** Skill 默认也允许模型自动选择。 */
    let model = true;
    if (markdown.data.invocation !== undefined) {
      /** invocation 保留平台中立的两个布尔维度。 */
      const invocation = markdown.data.invocation;
      if (typeof invocation !== 'object' || invocation === null || Array.isArray(invocation)) {
        error(diagnostics, 'SKILL_INVOCATION_INVALID', 'invocation must be a mapping.', skillFile.path, ['invocation']);
      } else {
        for (const field of Object.keys(invocation)) {
          if (field !== 'user' && field !== 'model')
            error(diagnostics, 'SKILL_INVOCATION_FIELD', `Unknown invocation field "${field}".`, skillFile.path, ['invocation', field]);
        }
        /** invocationUser 只接受显式布尔值。 */
        const invocationUser = (invocation as Record<string, unknown>).user;
        if (typeof invocationUser === 'boolean')
          user = invocationUser;
        else if ((invocation as Record<string, unknown>).user !== undefined)
          error(diagnostics, 'SKILL_INVOCATION_BOOLEAN', 'invocation.user must be boolean.', skillFile.path, ['invocation', 'user']);
        /** invocationModel 使用与 user 相同的严格布尔边界。 */
        const invocationModel = (invocation as Record<string, unknown>).model;
        if (typeof invocationModel === 'boolean')
          model = invocationModel;
        else if ((invocation as Record<string, unknown>).model !== undefined)
          error(diagnostics, 'SKILL_INVOCATION_BOOLEAN', 'invocation.model must be boolean.', skillFile.path, ['invocation', 'model']);
      }
    }
    if (!user && !model)
      error(diagnostics, 'SKILL_INVOCATION_EMPTY', 'invocation.user and invocation.model cannot both be false.', skillFile.path, ['invocation']);
    /** 递归枚举后只把普通辅助文件签发为 SourceAsset。 */
    const auxiliary = [] as { path: string; asset: SourceAssetRef }[];
    for (const child of await sources.list(entry.directory, { recursive: true })) {
      if (child.type !== 'file' || child.path === skillFile.path)
        continue;
      /** 辅助资源路径相对 Skill 根而不是项目根。 */
      const relative = child.path.slice(`${entry.path}/`.length);
      auxiliary.push(Object.freeze({ path: safeRelativePath(relative), asset: await assets.fromSource(child.file) }));
    }
    auxiliary.sort((left, right) => compareCodePoints(left.path, right.path));
    result.push(Object.freeze({
      kind: 'skill',
      id: entry.name,
      description,
      invocation: Object.freeze({ user, model }),
      body: markdown.body,
      location: Object.freeze({ path: skillFile.path, bodyLine: markdown.bodyLine }),
      requires: requires(markdown.data.requires, skillFile.path, diagnostics),
      platforms: platforms(markdown.data.platforms, configured, skillFile.path, diagnostics),
      auxiliaryFiles: Object.freeze(auxiliary),
    }));
  }
  return Object.freeze(result.sort((left, right) => compareCodePoints(left.id, right.id)));
}
