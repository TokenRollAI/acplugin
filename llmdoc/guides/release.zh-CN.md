# 手动发布独立版本化的公开 package

> [English version](release.md)

仓库包含九个独立版本化的公开 package：

- `@tokenroll/acplugin`
- `@tokenroll/acplugin-platform-claude-code`
- `@tokenroll/acplugin-platform-codex`
- `@tokenroll/acplugin-platform-cursor`
- `@tokenroll/acplugin-platform-antigravity`
- `@tokenroll/acplugin-platform-opencode`
- `@tokenroll/acplugin-platform-pi`
- `@tokenroll/acplugin-extension-hooks`
- `@tokenroll/acplugin-extension-mcp`

Core、测试工作区、Docs 和 Playground 是私有包，不能发布，也不能作为运行时依赖出现在 tarball 中。所有 npm 发布、Registry 检查、Git Tag 和 GitHub Release 均由获得授权的维护者手工执行。仓库没有自动发布工作流。

仓库构建与发布工具要求 Node.js `^22.18.0 || >=24.11.0`，CI 固定使用 22.18.0；九个公开 package 当前都声明独立的运行时范围 `^20.19.0 || ^22.13.0 || >=23.5.0`。

## 仓库工作流

`Check` 在 Pull Request 创建时自动执行：一个 Job 运行 lint/typecheck，另一个独立 Job 运行 `docs:check`，重新生成 API 页面、检查 VitePress 链接/结构，并验证及构建真实 Playground。

`Verify` 仅能手工触发，并使用只读仓库权限。它在 Node 22.18 上从同一 Revision 构建和验证九个 tarball，上传这组精确 Artifact，再在干净的 Node 20.19 工程中消费同一组文件；不会发布或创建 Release 引用。同一 Revision 一起验证不代表这些 package 属于固定版本组。

`Patch` 从仓库默认分支手工触发，必须提供目标分支。目标分支必须至少包含一个让公开 package 产生发布的有效 Changeset；空 Changeset 不满足门禁。工作流会在任何版本写入前使用 `pnpm changeset status` 验证发布计划，再用 `pnpm version-packages` 消费全部 Changeset，确认至少一个公开版本发生变化，刷新 pnpm lockfile，运行 lint 和 typecheck，然后创建或更新一个以所选目标分支为 base 的版本 PR。

为了让 `Patch` 使用 `GITHUB_TOKEN` 创建 PR，必须启用仓库设置 **Actions → General → Workflow permissions → Allow GitHub Actions to create and approve pull requests**。该工作流不会发布 package，也不会创建任何 Release 引用。

## 准备发布

1. 为受影响的公开 package 添加 Changeset。集成实现变更应指向所属 Platform/Extension；只有 CLI 或公开 SDK 变化时才更新主包。
2. 检查 `pnpm changeset status`，使用 `pnpm version-packages` 消费 Changeset，再用 `pnpm install --lockfile-only` 刷新 lockfile，并确认只有预期 manifest 发生变化；各 package 版本无需相同。
3. 确认所有官方 Platform/Extension 在仓库中仍把 `@tokenroll/acplugin` 声明为 `workspace:^`；pack 后必须改写成普通 `^x.y.z` peer range。
4. 运行：

   ```bash
   pnpm install --frozen-lockfile
   pnpm run check
   pnpm run docs:check
   pnpm run release:verify
   ```

`release:verify` 会在临时目录中打包九个 package，对实际 tarball 执行类型解析与 Package Lint，检查 manifest 和内容，验证 peer rewrite，以及经同一主包 peer 实例产生的私有 Symbol 品牌互操作，再在干净外部消费者中安装并构建六 Platform/两 Extension 脚手架。对于主包，它会解析 tarball 内真实 ESM 图，证明 CLI 到 Migration 的边仍是 lazy，逐条核对外部 import 与已声明运行时依赖，并拒绝主包正常运行图对官方集成产生依赖。它绝不会发布任何内容。CI 通过 `--tarball-dir <empty-directory>` 保留精确验证过的文件，供独立 Node 20.19 consumer job 使用；本地需要保留待发布 tarball 时也可使用该参数。

发布前必须提交这份精确验证过的发布准备。验证后不得从另一个 Revision 重新构建待发布文件。

## 选择待发布 tarball

只发布本次计划中版本发生变化的 package。保留或下载 `release:verify` 产生的九 tarball 精确 Artifact 集，再从中选择变更 package 对应的 tarball。未变化的 tarball 只是跨包验证输入，不是待发布版本。

发布集成 package 前，检查其 tarball 中 `@tokenroll/acplugin` 的 peer range：

- 如果该范围要求同次发布中的新主包版本，先发布并验证主包；
- 如果 Registry 中已有主包版本满足该范围，集成可以独立发布；
- 各 Platform 与 Extension 之间没有发布顺序依赖。

## 手动发布

由获得授权的 TokenRoll npm 组织维护者使用 2FA 发布每个选中的 tarball，并立即检查其精确版本：

```bash
npm publish <tarball-path> --access public --otp <OTP>
npm view <package-name>@<version> version
```

首次发布九个 `0.0.1-beta` package 时，可以由维护者在仓库根手工执行简化命令：

```bash
pnpm run publish:beta
```

根 `prepublish:beta` 会先执行 frozen install 和 `release:preflight`。该前置检查依次执行 lint/typecheck、一次全仓构建、关闭 package pre/post 生命周期的测试、不再重建全仓的 Docs/Playground 验证，最后执行 `release:verify`；随后 `pnpm -r publish` 只选择 `@tokenroll/*` 公开包，并使用固定的 npmjs Registry 与 `beta` tag。九个公开 package 各自通过 `prepublishOnly` 在实际 pack 前重建自身。该命令只适用于所有九个包均为首次发布的 `0.0.1-beta` cohort，不得复用于稳定版或独立增量发布，也不得由 Workflow 自动调用。

如果发布过程被中断，查询计划中的每个精确版本，只继续发布 peer dependency 已可满足且 Registry 中仍缺失的版本。npm 版本不可变，不能重复发布。

## 手动创建 Release 引用

旧的单一 package cohort `tokenroll-vX.Y.Z` Tag 无法表达独立版本，已不再适用。在 Registry 可查询到某个 package 的精确版本后，维护者可以按照仓库另行确认的命名约定创建该 package 专属 Tag 和 GitHub Release。不要在 Workflow 中猜测或自动化尚未确认的命名格式。

## 安全规则

- 恢复过程中绝不使用 `npm unpublish`，也不修改 dist-tag；
- 集成 tarball 的主包 peer range 尚未存在于 Registry 时，绝不发布该集成；
- 绝不发布私有 `@acplugin/*` 工作区 package；
- 不因九个 package 一起验证就重复发布未变化的 package；
- 在验证对应 npm 精确版本前，绝不创建或推送 Release 引用；
- 未经明确项目决策，绝不添加或调用自动 npm 发布、Tag 创建或 GitHub Release 自动化；
- 发布审计结束后，删除保存 tarball 的私有临时目录。
