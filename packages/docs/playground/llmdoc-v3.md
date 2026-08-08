# llmdoc v3 模板

`packages/playground` 是仓库内真实 ACPlugin consumer，以 llmdoc v3 的作者资源形态覆盖 Commands、Skill auxiliary、Agents、Hooks 与 Public 文件。

```ts
import { defineConfig } from '@tokenroll/acplugin';
import hooks from '@tokenroll/acplugin-extension-hooks';
import claudeCode from '@tokenroll/acplugin-platform-claude-code';
import codex from '@tokenroll/acplugin-platform-codex';

export default defineConfig({
  name: 'llmdoc-v3-playground',
  version: '0.1.0',
  description: 'llmdoc v3 authoring template for ACPlugin integration exercises.',
  platforms: [claudeCode(), codex()],
  extensions: [hooks()],
  build: { strict: false },
});
```

## 模板内容

- `init`、`update`、`prune`、`upgrade` Commands。
- `llmdoc` Skill 与 Frontier、transaction、reflection promotion、compact continuation references。
- investigator、reflector、recorder Agents。
- SessionStart、PreCompact、Stop 三个 no-op Hooks。
- runtime/schema/upgrade 边界说明和四个知识模板。

## 已知差异与非目标

Playground 不实现 Frontier 状态、fingerprint、knowledge graph、delta、transaction、rollback、`meta.json`、可执行 Schema、Migration runtime、MCP、增量更新或缓存。

Codex Command 当前生成 `command-*` Skill，不等同于 llmdoc v3 的 `llmdoc-*` 目标命名。Codex Agent 降级为 `agent-*` guidance Skill，不是 `runtime/agents` scoped subagent。`upgrade` 只有显式入口，不能证明完整迁移正文物理惰性加载。

三个 Hook 都返回 `void`，不会读写知识库。`public/schemas` 只有边界说明，不构成 Schema。因此它是 packaging/template smoke，不是 llmdoc v3 产品实现或 conformance suite。

## 运行

```bash
pnpm playground:check
```

配置使用 `strict: false` 是为了允许已知 Codex Agent degradation 及其向依赖 Command 的传播；结构、安全、owner、来源和事务错误仍必须失败。仓库 verifier 会拒绝白名单之外的新诊断或任何 unsupported 结果。
