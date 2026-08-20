import type {
  AgentComponent,
  CanonicalProject,
  CommandComponent,
  SkillComponent,
} from '../../contracts/components.js';
import type { PluginMetadata } from '../../contracts/config.js';
import { AssetRegistry } from '../../services/assets.js';
import { DiagnosticRegistry } from '../../services/diagnostics.js';
import { compareCodePoints } from '../../security/path-policy.js';
import { SourceRegistry } from '../../services/sources.js';
import type { CanonicalResourceRoot, ResourceClaims } from '../registry.js';
import { discoverAgents } from './agents.js';
import { discoverCommands } from './commands.js';
import { discoverSkills } from './skills.js';

/**
 * 校验跨 Command/Skill/Agent 的依赖图。
 *
 * @param components 完整 canonical Component 集。
 * @param diagnostics 当前诊断集合。
 */
function validateGraph(
  components: readonly (CommandComponent | SkillComponent | AgentComponent)[],
  diagnostics: DiagnosticRegistry,
): void {
  /** kind+id 是允许不同 Component 类型同名的图键。 */
  const key = (kind: string, id: string): string => `${kind}:${id}`;
  /** 完整 Component 索引用于检查引用存在性。 */
  const byKey = new Map(components.map(component => [key(component.kind, component.id), component]));
  /** 只记录通过存在性和自引用检查的有向边。 */
  const edges = new Map<string, string[]>();
  for (const component of components) {
    /** 当前 Component 的唯一图节点键。 */
    const from = key(component.kind, component.id);
    /** Command/Skill/Agent 统一投影为可引用 Skill/Agent 目标。 */
    const targets = [
      ...component.requires.skills.map(id => key('skill', id)),
      ...component.requires.agents.map(id => key('agent', id)),
    ];
    /** 合法边按目标键稳定排序后进入 DFS。 */
    const valid: string[] = [];
    for (const target of targets) {
      if (target === from) {
        diagnostics.report('validate', { code: 'COMPONENT_DEPENDENCY_SELF', severity: 'error', message: `${from} cannot require itself.`, location: { path: component.location.path } }, { owner: 'framework:canonical', component: { kind: component.kind, id: component.id } });
      } else if (!byKey.has(target)) {
        diagnostics.report('validate', { code: 'COMPONENT_DEPENDENCY_MISSING', severity: 'error', message: `${from} requires missing ${target}.`, location: { path: component.location.path } }, { owner: 'framework:canonical', component: { kind: component.kind, id: component.id } });
      } else {
        valid.push(target);
      }
    }
    edges.set(from, valid.sort(compareCodePoints));
  }
  /** visiting 表示当前 DFS 路径上的灰色节点。 */
  const visiting = new Set<string>();
  /** visited 表示已经完成验证的黑色节点。 */
  const visited = new Set<string>();
  /** stack 保留完整循环路径用于稳定诊断。 */
  const stack: string[] = [];
  /** reported 避免同一环路从多个入口重复报告。 */
  const reported = new Set<string>();
  /** 深度优先遍历检测依赖图中的回边。 */
  const visit = (node: string): void => {
    if (visited.has(node))
      return;
    if (visiting.has(node)) {
      /** 回边闭合为包含首尾节点的完整可读路径。 */
      const cycle = [...stack.slice(stack.indexOf(node)), node].join(' -> ');
      if (!reported.has(cycle)) {
        diagnostics.report('validate', { code: 'COMPONENT_DEPENDENCY_CYCLE', severity: 'error', message: `Dependency cycle: ${cycle}.` }, { owner: 'framework:canonical' });
        reported.add(cycle);
      }
      return;
    }
    visiting.add(node);
    stack.push(node);
    for (const target of edges.get(node) ?? [])
      visit(target);
    stack.pop();
    visiting.delete(node);
    visited.add(node);
  };
  for (const node of [...byKey.keys()].sort(compareCodePoints))
    visit(node);
}

/** Canonical Provider 的 Session registries。 */
export interface CanonicalProviderOptions {
  readonly metadata: Readonly<PluginMetadata>;
  readonly platformIds: readonly string[];
  readonly claims: ResourceClaims;
  readonly sources: SourceRegistry;
  readonly assets: AssetRegistry;
  readonly diagnostics: DiagnosticRegistry;
}

/**
 * 发现并验证 Canonical Component graph。
 *
 * Public 和 Runtime 由各自 Provider 合并，因此这里先返回空 publicFiles。
 *
 * @param options 当前 BuildSession registries 与 claims。
 * @returns 不含物理路径的不可变 canonical project。
 */
export async function discoverCanonicalProject(options: CanonicalProviderOptions): Promise<CanonicalProject> {
  /** canonical Source capability 固定绑定 Framework owner。 */
  const sourceService = options.sources.service('framework:canonical');
  /** Skill auxiliary Asset 同样保留 canonical issuer。 */
  const assetService = options.assets.service('framework:canonical');
  /** configured Set 只用于拒绝未安装 Platform namespace。 */
  const configured = new Set(options.platformIds);
  /** 三类互相独立的来源并行扫描，最终诊断由 Registry 排序。 */
  const [discoveredCommands, discoveredSkills, discoveredAgents] = await Promise.all([
    discoverCommands(options.claims.canonical.commands, sourceService, configured, options.diagnostics),
    discoverSkills(options.claims.canonical.skills, sourceService, assetService, configured, options.diagnostics),
    discoverAgents(options.claims.canonical.agents, sourceService, configured, options.diagnostics),
  ]);
  validateGraph([...discoveredCommands, ...discoveredSkills, ...discoveredAgents], options.diagnostics);
  return Object.freeze({
    metadata: options.metadata,
    commands: discoveredCommands,
    skills: discoveredSkills,
    agents: discoveredAgents,
    publicFiles: Object.freeze([]),
  });
}

/** Framework canonical root names的 compile-time exhaustiveness guard。 */
const _canonicalRoots: readonly CanonicalResourceRoot[] = ['commands', 'skills', 'agents'];
void _canonicalRoots;
