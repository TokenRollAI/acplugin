# 故障排查

优先使用 `--json` 获取稳定诊断码、phase、fieldPath 和安全 location，不要依赖可能调整的人类文案。

## 配置失败

- `CONFIG_PLATFORMS_REQUIRED`：安装 Platform package，并把至少一个工厂结果放入必填 `platforms`。
- `CONFIG_PLATFORM_INVALID`：不能手写 shape；使用官方工厂或公开 `definePlatform()`。
- `CONFIG_DIRECTORY_OVERLAP`：`srcDir` 与 `build.outDir` 必须是分离的工程子树。
- `CONFIG_PUBLIC_OVERLAP`：Public 完整目录或 copy source 不能与源码、输出或配置入口重叠。

## Resource discovery 或 Canonical validation 失败

- `FRONTMATTER_REQUIRED`：文件第一行必须是 `---`。
- `MARKDOWN_BODY_REQUIRED`：Frontmatter 后必须有非空正文。
- `SOURCE_ROOT_INVALID` / `SOURCE_ROOT_CONTENT_INVALID` / `RESOURCE_ROOT_CONTENT_INVALID`：使用工程内普通目录和文件，移除符号链接、特殊文件与规范化冲突。
- `COMPONENT_DEPENDENCY_MISSING` / `COMPONENT_DEPENDENCY_SELF` / `COMPONENT_DEPENDENCY_CYCLE`：检查 `requires` 中的 ID、自依赖和完整循环。

## Extension 失败

发现 `src/hooks` 或 `src/mcp` 内容却未启用对应 Extension 时，安装独立 package 并添加 `hooks()` 或 `mcp()`。`src/runtime` 由 Core 直接扫描；使用 `runtime.entries` 修正入口映射，或用 `runtime: false` 显式关闭。不要删除诊断或把目录放进 Public 来绕过验证。

## strict 失败

先运行 `inspect --json` 查看是哪一资源为 degraded/unsupported。确认目标平台确实允许降级后，才在全局 `build.strict` 或单个 Platform factory 中显式放宽。结构和安全错误不会被放宽。

## 事务或锁失败

不要手工删除未知 transaction/backup 内容。重新运行命令会先执行恢复；若持续失败，保留完整脱敏报告和目录结构再提交问题。
