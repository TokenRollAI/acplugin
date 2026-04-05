# acplugin 项目规范

## 项目概述

acplugin 是一个 CLI 工具，将 Claude Code 插件（Skills、Instructions、MCP、Agents、Commands、Hooks）转换为 Codex CLI、OpenCode 和 Cursor 格式。

## 技术栈

- TypeScript + Node.js (CommonJS)
- Commander.js (CLI)
- @inquirer/prompts + chalk (TUI)
- gray-matter (YAML frontmatter)
- @iarna/toml (TOML 序列化)
- vitest (测试)

## 项目结构

```
src/
├── index.ts              # CLI 入口 + 交互式 wizard
├── types.ts              # 所有类型定义
├── github.ts             # GitHub 仓库下载
├── tui.ts                # TUI 交互（wizard、checkbox、彩色输出）
├── scanner/
│   ├── claude.ts          # .claude/ 项目结构扫描（导出可复用函数）
│   └── plugin.ts          # .claude-plugin/ 插件格式扫描
├── converter/
│   ├── skill.ts           # SKILL.md 转换
│   ├── instructions.ts    # CLAUDE.md → AGENTS.md / .mdc
│   ├── mcp.ts             # .mcp.json → TOML / JSON
│   ├── agent.ts           # Agent 定义转换（含降级策略）
│   ├── command.ts         # Command 转换
│   └── hooks.ts           # Hooks 转换（含兼容性报告）
├── writer/
│   ├── codex.ts           # Codex 输出编排
│   ├── opencode.ts        # OpenCode 输出编排
│   └── cursor.ts          # Cursor 输出编排
└── utils/
    ├── frontmatter.ts     # YAML frontmatter 解析/序列化
    ├── toml.ts            # TOML 工具
    └── fs.ts              # 文件系统工具
```

## 架构设计原则

- **三阶段 Pipeline**: Scanner → Converter → Writer
- **Scanner 提取可复用函数**: `scanSkillsDir()`, `scanAgentsDir()` 等被 claude.ts 和 plugin.ts 共用
- **Converter 无副作用**: 接收数据，返回 `ConvertedFile`，不直接写文件
- **Writer 负责编排**: 调用多个 converter，处理合并逻辑（如多个 instruction 合并为一个 AGENTS.md）
- **降级策略**: 目标平台不支持的功能降级为文档/规则，并输出 warning

## 开发规范

### 添加新资源类型
1. 在 `types.ts` 添加类型定义
2. 在 `scanner/claude.ts` 添加扫描函数（导出为可复用）
3. 在 `scanner/plugin.ts` 集成
4. 创建 `converter/xxx.ts`，实现三个平台的转换
5. 在三个 `writer/*.ts` 中调用 converter
6. 添加测试

### 添加新目标平台
1. 在 `types.ts` 的 `Platform` 联合类型添加新值
2. 每个 `converter/*.ts` 添加新平台的转换逻辑
3. 创建 `writer/newplatform.ts`
4. 在 `index.ts` 注册
5. 在 `tui.ts` 的 `selectPlatforms()` 添加选项
6. 添加测试

### Frontmatter 解析容错
- 社区插件的 YAML frontmatter 可能格式不规范
- `scanSkillsDir()` 和 `scanAgentsDir()` 已加 try-catch
- 解析失败时保留原始内容，frontmatter 设为空对象

### 测试
- 测试文件在 `src/__tests__/`
- test-fixture/ 目录提供完整的 Claude Code 项目示例
- 运行: `npm test` 或 `npx vitest run`
- 每个 converter 模块有独立测试文件

### npm 发布
- 包名: `@disdjj/acplugin`
- 账号有 2FA，发布需要 OTP: `npm publish --access=public`
- `prepublishOnly` 自动编译
- `files` 字段排除了 `dist/__tests__/`

## Git 规范

- commit message 使用 conventional commits 格式
- 仓库: https://github.com/TokenRollAI/acplugin
- 主分支: main
