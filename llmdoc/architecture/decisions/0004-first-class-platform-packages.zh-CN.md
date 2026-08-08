# ADR-0004：Platform 是一等独立生态包

- 状态：已接受
- 日期：2026-08-08
- 适用范围：acplugin 1.0 package API

## 背景

六个官方 Platform 原先是私有 `@acplugin/*` workspace 包，由主包内联并重新导出。该模型虽然让单 tarball 使用简单，却让官方 Platform 依赖第三方无法访问的 Core，并迫使主包知道全部官方实现。Extension 已证明“独立公开 package + 主包 peer dependency + 公开 lifecycle SDK”可以保持 owner、品牌和生命周期边界。

`@tokenroll/acplugin/platforms/<id>` 只是主包 export subpath，不是独立 npm package，不能提供独立安装、版本和第三方对等发布模型。

## 决策

1. `@tokenroll/acplugin` 只承担 CLI 和公开框架 SDK，不重新导出官方 Platform/Extension。
2. 六个官方 Platform 分别发布为 `@tokenroll/acplugin-platform-<id>`，两个 Extension 继续使用 `@tokenroll/acplugin-extension-<name>`。
3. 所有官方集成只从 `@tokenroll/acplugin` 导入公开契约，并把它声明为 peer dependency；生产源码不得导入私有 Core。
4. `platforms` 配置必填。主包不按缺省值或 ID 加载官方实现；`init` 通过显式依赖和 import 保留默认 Claude Code/Codex 的脚手架体验。
5. 官方集成独立版本化，以 lifecycle `apiVersion` 和主包 peer range 表达兼容性。
6. 第三方包无需注册、无需官方 scope，也不强制命名；只要使用公开工厂和契约即可参与同一 lifecycle。
7. 1.0 不保留旧主包 re-export 或 Platform subpath 兼容层。

## 影响

- 使用者必须安装并 import 所需 Platform package，配置依赖变得显式、可审计。
- 官方 Platform 成为第三方作者可复制的真实 package 范例。
- 主包正常运行图不随官方 Platform 数量增长。
- 发布验证从三个公开 tarball 扩展到九个，并验证 peer rewrite、品牌互操作与 clean consumer。
- `init`、Migration、文档、fixture 和 release workflow 必须同步使用独立包名。

## 未采用方案

- 主包 `./platforms/*` subpath：仍由主包拥有版本和发布边界，不是一等生态包。
- 同时保留 re-export：会让错误入口继续成为事实标准，并使主包无法真正收窄。
- 按 Platform ID 自动安装或发现包：引入网络副作用、命名注册和不可重复解析。
- 公开私有 Core 包：扩大内部 Registry/事务表面，破坏主包作为唯一 SDK 边界。

## 证据

- `packages/acplugin/src/index.ts`
- `packages/acplugin/src/project-config.ts`
- `packages/acplugin/tsdown.config.ts`
- `packages/platforms/*/package.json`
- `packages/extensions/*/package.json`
- 规范 §4.2–§4.4、§5.2、§19
