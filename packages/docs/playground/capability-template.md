# 全能力模板

`packages/playground` 是仓库内真实 ACPlugin consumer，以通用工程示例覆盖 Commands、Skill auxiliary、Agents、全部 portable Hooks、HTTP/local MCP 与 Public 文件，不绑定任何具体产品领域。

```ts
import { defineConfig } from '@tokenroll/acplugin';
import hooks from '@tokenroll/acplugin-extension-hooks';
import mcp from '@tokenroll/acplugin-extension-mcp';
import antigravity from '@tokenroll/acplugin-platform-antigravity';
import claudeCode from '@tokenroll/acplugin-platform-claude-code';
import codex from '@tokenroll/acplugin-platform-codex';
import cursor from '@tokenroll/acplugin-platform-cursor';
import openCode from '@tokenroll/acplugin-platform-opencode';
import pi from '@tokenroll/acplugin-platform-pi';

export default defineConfig({
  name: 'acplugin-capability-playground',
  version: '0.1.0',
  description: 'Complete ACPlugin capability template for integration exercises.',
  platforms: [claudeCode(), codex(), cursor(), antigravity(), openCode(), pi()],
  extensions: [hooks(), mcp()],
  build: { strict: false },
});
```

## 模板内容

- `init`、`update`、`prune`、`upgrade` 通用工程 Commands。
- `project-workflow` Skill、四个工作流 references 与两个 Skill-local icon。
- investigator、reflector、recorder Agents。
- 全部 11 个 portable Hook 事件及其无副作用语义结果。
- public、OAuth、Bearer 三类 remote HTTP MCP，以及完整 local stdio MCP。
- runtime/schema/upgrade 静态资源示例、品牌资源和四个 Public 模板。
- 六个平台主交付单元与 Claude Code/Codex Marketplace。

## 输出验证

验证器消费真实 `validate --json` 和 `build --json`，逐项检查六平台兼容性矩阵、Artifact Registry 与文件树闭包、Component 转换内容、Manifest/Config 引用、Hook runtime、MCP JSON-RPC、Secret 不泄漏和双构建字节确定性。平台明确 unsupported 的事件或 transport 必须出现在兼容性报告中，同时不得生成伪配置或伪运行文件。

## 模板边界

Playground 不实现具体产品业务，只展示作者工程结构、公开 API、平台转换、Extension 协议和交付产物验证。示例 Handler 与 Server 无持久化副作用。

Codex 和 Antigravity 会把 Command 转为 `command-*` Skill，Pi 转为 Prompt Template；Codex、Antigravity 和 Pi 会把 Agent 降级为 `agent-*` guidance Skill。这些是平台明确报告的兼容性结果。

Hooks 和 MCP 提供可执行但无持久化副作用的协议模板；`public/schemas` 只展示静态资源交付位置，不构成业务 Schema。因此它是 ACPlugin 全能力 packaging/template smoke，不是平台官方 conformance suite。

## 运行

```bash
pnpm playground:check
```

配置使用 `strict: false` 是为了显式观察六平台的真实能力差异；结构、安全、owner、来源和事务错误仍必须失败。仓库 verifier 会精确接受已声明的 degradation/unsupported，同时验证这些不支持项没有生成伪 Artifact。
