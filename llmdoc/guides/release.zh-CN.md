# 发布独立版本化的公开 package

> [English version](release.md)

ACPlugin 有九个独立版本化的公开 npm package：主包、六个 Platform package 与 Hooks/MCP Extension。Core、Test、Docs、Playground 均为私有 package，绝不能发布。

仓库工具链要求 Node.js `^22.18.0 || >=24.11.0`；已发布 package 另行支持 `^20.19.0 || ^22.13.0 || >=23.5.0`。

## 工作流

1. 指向 `main` 的功能 PR 为每个受影响的公开 package 提交 Changeset。
2. PR 创建或更新时，`Lint` 与 `Typecheck` Action 分别运行。
3. 功能 PR 合并到 `main` 后，`Changelog` 消费待处理 Changeset，创建或更新 `chore(release): version packages`。版本 PR 包含 package manifest 版本、changelog 与生成的公开版本快照，不会发布。
4. 审核独立版本升级是否符合预期后再合并版本 PR。
5. beta 在本地发布；稳定版由维护者手工触发 `Release`。

`Changelog` 需要通过 `GITHUB_TOKEN` 创建版本 PR，因此仓库必须启用 **Actions → General → Workflow permissions → Allow GitHub Actions to create and approve pull requests**。

## 准备 beta

在已合并的版本 Revision 上先检查 pnpm 的无写入计划：

```bash
pnpm install --frozen-lockfile
pnpm run publish:beta:dry-run
```

确认计划正确后，获得 npm 权限的维护者在本地执行：

```bash
pnpm run publish:beta
```

若 npm 要求命令行一次性验证码，追加 `--otp <OTP>`。根命令会构建 workspace，随后用 pnpm 递归发布 `@tokenroll/*` 公开 workspace。由于根构建已经产出内容，发布阶段会跳过重复的 package lifecycle scripts。pnpm 会为每个公开 package 打包，并将仓库中的 `workspace:^` peer range 改写为普通已发布范围。

## 发布稳定版

先退出 Changesets prerelease mode，并合并稳定版版本 PR；随后从 `main` 手动触发 `Release` Action。该 Action 拒绝 prerelease 版本，并使用同一套递归公开 workspace 发布命令写入 npm `latest`。

`Release` 有意保持手动：它使用仓库的 `NPM_TOKEN` secret，但绝不因 PR 或 push 自动触发；它不会创建 Git Tag、GitHub Release，也不会执行独立 dist-tag 修改。

## 安全规则

- 绝不发布私有 `@acplugin/*` package；根发布脚本只筛选 `@tokenroll/*`。
- 不用 `npm unpublish` 恢复失败发布。
- 未另获授权时，不创建 Tag 或 GitHub Release。
- npm 中已存在精确版本时，让 pnpm 报告并跳过；若需要改变该 package 内容，先升级版本再重试。
- 官方 Platform/Extension manifest 中必须保持 `@tokenroll/acplugin: workspace:^`；打包 peer range 改写由 pnpm 负责。
- 涉及行为、package 边界、Docs 或 Playground 的改动应运行 `pnpm run test` 与 `pnpm run docs:check`。PR Action 有意只保留 lint 与 typecheck。
