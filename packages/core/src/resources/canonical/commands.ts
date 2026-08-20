import type { CommandComponent } from '../../contracts/components.js';
import type { SourceDirectoryRef } from '../../contracts/services.js';
import { DiagnosticRegistry } from '../../services/diagnostics.js';
import { compareCodePoints } from '../../security/path-policy.js';
import { SourceRegistry } from '../../services/sources.js';
import { componentId, error, fields, parseMarkdown, platforms, requires, rootEntries, stringField } from './shared.js';

/**
 * 扫描 Command root。
 *
 * @param root 可选 commands root。
 * @param sources canonical Source Service。
 * @param configured 配置 Platform IDs。
 * @param diagnostics 当前诊断集合。
 * @returns 有效 Commands。
 */
export async function discoverCommands(
  root: SourceDirectoryRef | undefined,
  sources: ReturnType<SourceRegistry['service']>,
  configured: ReadonlySet<string>,
  diagnostics: DiagnosticRegistry,
): Promise<readonly CommandComponent[]> {
  /** 扫描结果在完成后按 ID 排序并冻结。 */
  const result: CommandComponent[] = [];
  for (const entry of await rootEntries(root, sources)) {
    if (entry.type !== 'file' || !entry.name.endsWith('.md')) {
      error(diagnostics, 'COMMAND_ENTRY_INVALID', 'Commands must be one-level .md files.', entry.path);
      continue;
    }
    /** Command ID 来自精确 .md 文件名。 */
    const id = entry.name.slice(0, -3);
    if (!componentId(id, entry.path, diagnostics))
      continue;
    /** Markdown parsing 只使用当前 owner 的 SourceRef。 */
    const markdown = await parseMarkdown(sources, entry.file, diagnostics);
    if (markdown === undefined)
      continue;
    fields(markdown.data, ['description', 'argumentHint', 'requires', 'platforms'], entry.path, diagnostics);
    /** description 是所有 canonical Component 的必填字段。 */
    const description = stringField(markdown.data, 'description', entry.path, diagnostics, true);
    if (description === undefined)
      continue;
    for (const placeholder of markdown.body.match(/\{\{[^{}]*\}\}/gu) ?? []) {
      if (placeholder !== '{{arguments}}')
        error(diagnostics, 'COMMAND_PLACEHOLDER_INVALID', `Unsupported Command placeholder "${placeholder}".`, entry.path);
    }
    /** argumentHint 保持可选且不解释平台语义。 */
    const argumentHint = stringField(markdown.data, 'argumentHint', entry.path, diagnostics);
    result.push(Object.freeze({
      kind: 'command',
      id,
      description,
      ...(argumentHint === undefined ? {} : { argumentHint }),
      body: markdown.body,
      location: Object.freeze({ path: entry.path, bodyLine: markdown.bodyLine }),
      requires: requires(markdown.data.requires, entry.path, diagnostics),
      platforms: platforms(markdown.data.platforms, configured, entry.path, diagnostics),
    }));
  }
  return Object.freeze(result.sort((left, right) => compareCodePoints(left.id, right.id)));
}
