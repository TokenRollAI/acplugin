# 手动发布公开包组

> [English version](release.md)

以下公开包使用同一个版本发布：

- `@tokenroll/acplugin`
- `@tokenroll/acplugin-module-hooks`
- `@tokenroll/acplugin-module-mcp`

Core、内置 Compiler 和测试工作区是私有包，不能发布，也不能作为运行时依赖出现在 tarball 中。所有 npm 发布、Registry 检查、Git Tag 和 GitHub Release 均由获得授权的维护者手动执行。仓库没有自动发布工作流。

## 仓库工作流

`Check` 在 Pull Request 创建时自动执行，并且只运行 lint 和 typecheck。

`Patch` 从仓库默认分支手动触发，必须提供目标分支。目标分支必须至少包含一个除 `README.md` 外的 `.changeset/*.md` 文件。工作流会检出目标分支，使用 `pnpm version-packages` 消费全部 Changeset，验证固定公开包组的版本发生了变化，刷新 pnpm lockfile，运行 lint 和 typecheck，然后创建或更新一个以所选目标分支为 base 的版本 PR。

为了让 `Patch` 使用 `GITHUB_TOKEN` 创建 PR，必须启用仓库设置 **Actions → General → Workflow permissions → Allow GitHub Actions to create and approve pull requests**。该工作流不会发布包，也不会创建任何 Release 引用。

## 准备发布

1. 为用户可见变更添加 Changeset，并通过 `pnpm version-packages` 更新固定包组版本；
2. 确认三个公开清单版本完全相同，且仓库中的 Module Peer Dependency 仍使用 `workspace:^`；
3. 运行：

   ```bash
   pnpm install --frozen-lockfile
   pnpm run check
   pnpm run release:verify
   ```

`release:verify` 会在临时目录中打包三个包，检查清单与内容，把 tarball 安装到干净的外部消费者，然后对消费者执行类型检查、导入、验证和构建。它绝不会发布任何内容。

在打包最终待发布产物前，必须把经过精确验证的发布准备提交到 `main`。

## 打包发布包组

在仓库外创建私有临时目录，并按照依赖安全顺序打包：

```bash
ACPLUGIN_RELEASE_DIR="$(mktemp -d)"
pnpm --filter @tokenroll/acplugin-module-hooks pack --pack-destination "$ACPLUGIN_RELEASE_DIR"
pnpm --filter @tokenroll/acplugin-module-mcp pack --pack-destination "$ACPLUGIN_RELEASE_DIR"
pnpm --filter @tokenroll/acplugin pack --pack-destination "$ACPLUGIN_RELEASE_DIR"
```

继续之前检查三个生成的 tarball 路径。它们必须来自同一个已验证 Revision，并携带完全相同的版本。

## 手动发布

由获得授权的 TokenRoll npm 组织维护者使用 2FA 发布每个 tarball。严格遵循以下顺序：

1. `@tokenroll/acplugin-module-hooks`
2. `@tokenroll/acplugin-module-mcp`
3. `@tokenroll/acplugin`

每个 tarball 发布后，必须手动检查精确版本，再继续下一个：

```bash
npm publish <tarball-path> --access public --otp <OTP>
npm view <package-name>@<version> version
```

禁止发布私有 `@acplugin/*` 包。如果发布过程被中断，查询每个精确版本，并且只从规定顺序中第一个缺失的包继续。npm 版本不可变，不能重复发布。

## 手动创建 Release 引用

只有在 Registry 中可以查询到三个精确 npm 版本后，维护者才可以创建并推送匹配 Tag：

```bash
git tag tokenroll-vX.Y.Z
git push origin tokenroll-vX.Y.Z
```

该 Tag 不会触发发布。确认推送后的 Tag 和三个 Registry 版本后，再手动创建 GitHub Release。

## 安全规则

- 恢复过程中绝不使用 `npm unpublish`，也不修改 dist-tag；
- 在验证三个精确 npm 版本前，绝不创建或推送 Tag；
- 绝不发布私有 `@acplugin/*` 工作区包；
- 未经明确项目决策，绝不添加或调用自动 npm 发布、Tag 创建或 GitHub Release 自动化；
- 发布审计结束后，删除保存 tarball 的私有临时目录。
