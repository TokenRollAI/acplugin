# ADR-0003：分离仓库工具链与公开运行时支持

- 状态：已接受
- 日期：2026-08-08
- 适用版本：acplugin 1.0

## 背景

仓库构建工具与已发布包具有不同的 Node.js 约束。tsdown 0.22.14 要求 `^22.18.0 || >=24.11.0`，而 acplugin 希望保留受支持的 Node 20 运行时。先前的 Commander 15 要求 Node 22.12 或更高，因此与该产品目标冲突。其他直接运行依赖也要求精确 minor 范围，不能用宽泛的 `>=20` 准确表达。

## 决策

1. 仓库开发、构建和发布验证使用 `^22.18.0 || >=24.11.0`；标准 CI 版本为 22.18.0。
2. CLI 固定 Commander 14.0.1，该版本的 engine 仍包含 Node 20；现有 CLI 行为由子进程测试保护。
3. 全部公开 package 声明当前直接运行依赖的支持交集：`^20.19.0 || ^22.13.0 || >=23.5.0`。
4. 生成的 Hooks/MCP 代码与 package bundle 保持 `node20` target；`@types/node` 保持 Node 20.19 API 基线。
5. 不把私有 package manifest 批量改成仓库工具链范围。Core 不发布，其 emitted code 最终属于以 Node 20 为目标的主包 bundle。
6. 发布验证在 Node 22.18 构建并打包，再用单独的 Node 20.19 clean consumer smoke 安装同一批已验证 tarball。

## 影响

- Node 20 支持成为有测试的产品能力，而不是不准确的宽范围声明。
- 贡献者使用构建工具所需版本，但消费者无需被迫跟随仓库工具链。
- 升级运行依赖时必须重新检查公开 engine 交集与 Node 20.19 consumer 测试。
- 保留 Node 20 期间不能使用 Commander 15 专属能力；升级需要新的 runtime-floor 决策。

## 未采用方案

- 所有 manifest 保持 `>=20`：会声称支持直接依赖明确拒绝的版本。
- 全部公开 package 都抬到 Node 22.18：把消费者无谓绑定到仓库构建工具。
- 保留 Commander 15 同时声称支持 Node 20：内部矛盾。
- 在 Node 20 CI 安装整个 workspace：验证的是不受支持的 dev 工具链，而不是公开运行时。

## 证据

- 根 `package.json:7-9,29-44`
- `packages/acplugin/package.json:11,31-57`
- `packages/platforms/*/package.json:11`
- `packages/extensions/hooks/package.json:11,21-28`
- `packages/extensions/mcp/package.json:11,20-27`
- `.github/workflows/check.yml:16-19`
- `.github/workflows/patch.yml:42-46`
- lock 中固定的 tsdown 0.22.14、Commander 14.0.1、Chokidar 5.0.0、Rolldown 1.2.2 与 `@inquirer/prompts` 8.5.2 manifest
