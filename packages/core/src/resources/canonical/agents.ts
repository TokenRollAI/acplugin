import type { AgentCapability, AgentComponent, AgentModel } from '../../contracts/components.js';
import type { SourceDirectoryRef } from '../../contracts/services.js';
import { DiagnosticRegistry } from '../../services/diagnostics.js';
import { compareCodePoints } from '../../security/path-policy.js';
import { SourceRegistry } from '../../services/sources.js';
import { componentId, error, fields, parseMarkdown, platforms, requires, rootEntries, stringField, strings } from './shared.js';

/** Core 支持的平台中立 Agent model。 */
const AGENT_MODELS = new Set<AgentModel>(['inherit', 'fast', 'capable']);

/** Core 支持的平台中立 Agent capability。 */
const AGENT_CAPABILITIES = new Set<AgentCapability>([
  'filesystem:read', 'filesystem:write', 'search', 'shell', 'network', 'delegate',
]);

/**
 * 扫描 Agent root。
 *
 * @param root 可选 agents root。
 * @param sources canonical Source Service。
 * @param configured 配置 Platform IDs。
 * @param diagnostics 当前诊断集合。
 * @returns 有效 Agents。
 */
export async function discoverAgents(
  root: SourceDirectoryRef | undefined,
  sources: ReturnType<SourceRegistry['service']>,
  configured: ReadonlySet<string>,
  diagnostics: DiagnosticRegistry,
): Promise<readonly AgentComponent[]> {
  /** Agent 结果不携带任何平台物理输出信息。 */
  const result: AgentComponent[] = [];
  for (const entry of await rootEntries(root, sources)) {
    if (entry.type !== 'file' || !entry.name.endsWith('.md')) {
      error(diagnostics, 'AGENT_ENTRY_INVALID', 'Agents must be one-level .md files.', entry.path);
      continue;
    }
    /** Agent ID 来自精确 .md 文件名。 */
    const id = entry.name.slice(0, -3);
    if (!componentId(id, entry.path, diagnostics))
      continue;
    /** Agent 主文件使用相同严格 Frontmatter parser。 */
    const markdown = await parseMarkdown(sources, entry.file, diagnostics);
    if (markdown === undefined)
      continue;
    fields(markdown.data, ['description', 'model', 'capabilities', 'requires', 'platforms'], entry.path, diagnostics);
    /** description 缺失时不创建 Agent。 */
    const description = stringField(markdown.data, 'description', entry.path, diagnostics, true);
    if (description === undefined)
      continue;
    /** 未配置模型时保持跨平台的 inherit 语义。 */
    const rawModel = markdown.data.model ?? 'inherit';
    /** 非法模型回退用于继续收集诊断，但错误会阻止构建。 */
    const model: AgentModel = typeof rawModel === 'string' && AGENT_MODELS.has(rawModel as AgentModel) ? rawModel as AgentModel : 'inherit';
    if (model !== rawModel)
      error(diagnostics, 'AGENT_MODEL_INVALID', 'model must be inherit, fast, or capable.', entry.path, ['model']);
    /** capability 只保留 Core 定义的平台中立集合。 */
    const capabilities = strings(markdown.data.capabilities, ['capabilities'], entry.path, diagnostics)
      .filter((capability): capability is AgentCapability => {
        if (AGENT_CAPABILITIES.has(capability as AgentCapability))
          return true;
        error(diagnostics, 'AGENT_CAPABILITY_INVALID', `Unknown capability "${capability}".`, entry.path, ['capabilities']);
        return false;
      });
    result.push(Object.freeze({
      kind: 'agent',
      id,
      description,
      model,
      capabilities: Object.freeze(capabilities),
      body: markdown.body,
      location: Object.freeze({ path: entry.path, bodyLine: markdown.bodyLine }),
      requires: requires(markdown.data.requires, entry.path, diagnostics),
      platforms: platforms(markdown.data.platforms, configured, entry.path, diagnostics),
    }));
  }
  return Object.freeze(result.sort((left, right) => compareCodePoints(left.id, right.id)));
}
