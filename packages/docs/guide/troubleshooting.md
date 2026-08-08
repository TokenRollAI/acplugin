# 故障排查

优先使用 `--json` 获取稳定诊断码、phase、fieldPath 和安全 location，不要依赖可能调整的人类文案。

## 配置失败

- `CONFIG_PLATFORMS_REQUIRED` / `CONFIG_PLATFORMS_EMPTY`：安装 Platform package，并把工厂结果放入必填 `platforms`。
- `CONFIG_PLATFORM_INVALID`：不能手写 shape；使用官方工厂或公开 `definePlatform()`。
- `CONFIG_DIRECTORY_OVERLAP`：`srcDir`、Public 和 `build.outDir` 不能互相包含。
- `CONFIG_LEGACY_TARGETS` / `CONFIG_LEGACY_MODULES`：改用 `platforms` / `extensions`。

## Scanner 失败

- `FRONTMATTER_REQUIRED`：文件第一行必须是 `---`。
- `MARKDOWN_BODY_REQUIRED`：Frontmatter 后必须有非空正文。
- `SOURCE_SYMLINK_UNSUPPORTED`：换成工程内普通文件。
- 依赖图错误：检查 `requires` 中的 ID、self edge 和完整循环。

## Extension 失败

发现 `src/hooks` 或 `src/mcp` 内容却未启用对应 Extension 时，安装独立 package 并添加 `extensions: [hooks()]` 或 `extensions: [mcp()]`。不要删除诊断或把目录放进 Public 来绕过验证。

## strict 失败

先运行 `inspect --json` 查看是哪一资源为 degraded/unsupported。确认目标平台确实允许降级后，才在全局 `build.strict`、单个 Platform factory 或 CLI `--no-strict` 中显式放宽。结构和安全错误不会被放宽。

## 事务或锁失败

不要手工删除未知 transaction/backup 内容。重新运行命令会先执行恢复；若持续失败，保留完整脱敏报告和目录结构再提交问题。
