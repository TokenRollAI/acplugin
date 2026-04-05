---
name: npm-publish
description: 'Publish acplugin to npm with version bump, build, test, and 2FA handling'
disable-model-invocation: true
---

# npm 发布流程

## 步骤

1. **版本升级**
   ```bash
   npm version <major|minor|patch> --no-git-tag-version
   ```

2. **构建 + 测试**
   ```bash
   npm run build && npm test
   ```

3. **检查打包内容**（确认无测试文件）
   ```bash
   npm pack --dry-run
   ```

4. **发布**
   账号有 2FA，需要用户手动输入 OTP：
   ```
   提示用户运行: ! npm publish --access=public
   ```

5. **Commit + Push**
   ```bash
   git add package.json package-lock.json
   git commit -m "chore: bump version to $(node -p 'require("./package.json").version')"
   git push
   ```

## 注意事项

- 包名是 `@disdjj/acplugin`（scoped），必须加 `--access=public`
- 不要尝试在脚本中自动发布，2FA 会阻塞
- `prepublishOnly` 脚本会自动编译
- `files` 字段已排除 `dist/__tests__/`
