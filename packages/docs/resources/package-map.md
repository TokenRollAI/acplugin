# Package map

## Framework

| Package | 可见性 | 责任 |
| --- | --- | --- |
| `@tokenroll/acplugin` | Public | CLI、配置加载、公开 lifecycle SDK、程序化 API、隔离 Migration |
| `@acplugin/core` | Private | Scanner、lifecycle、诊断、Artifact、Document、DeliveryUnit、transaction |

## Official Platforms

`@tokenroll/acplugin-platform-claude-code`、`-codex`、`-cursor`、`-antigravity`、`-opencode`、`-pi` 都是公开独立 package，并以主包为 peer。主包不提供官方集成 subpath 或重导出。

## Official Extensions

- `@tokenroll/acplugin-extension-hooks`
- `@tokenroll/acplugin-extension-mcp`

Extension package 同时拥有作者格式、build state 和面向六个平台的官方 Adapter；Platform 不反向依赖 Extension。

## Repository-only consumers

| Workspace | 责任 |
| --- | --- |
| `@acplugin/test` | 跨包 Vitest、tarball 和架构验证 |
| `@acplugin/docs` | VitePress 与九个公开入口的 TypeDoc 生成 |
| `@acplugin/playground` | 领域中立的全能力 packaging/template smoke |

Docs 与 Playground 都是私有消费者，不进入 Changesets 或 release tarball。
