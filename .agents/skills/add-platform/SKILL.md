---
name: add-platform
description: 'Add support for a new target platform to acplugin (e.g., Windsurf, Zed, etc.)'
---

# 添加新目标平台

当需要支持新的 AI 编程工具作为转换目标时，按以下步骤操作。

## 前置调研

1. 了解目标平台的配置格式：
   - Skills/技能文件格式和路径
   - 自定义指令文件（类似 CLAUDE.md / AGENTS.md）
   - MCP 服务器配置格式
   - Agent 定义方式（如果有）
   - 命令/斜杠命令格式
   - Hooks 系统（如果有）

2. 确认格式差异和降级策略

## 实施步骤

### 1. 类型注册 (`src/types.ts`)

在 `Platform` 联合类型中添加新值：
```typescript
export type Platform = 'codex' | 'opencode' | 'cursor' | 'newplatform';
```

### 2. 每个 Converter 添加分支

在所有 `src/converter/*.ts` 文件中，给 `switch (platform)` 添加新的 case。

参考现有平台的转换逻辑，特别关注：
- **路径映射**：新平台的目录结构
- **Frontmatter 差异**：新平台是否需要特殊字段
- **降级策略**：不支持的功能如何处理

### 3. 创建 Writer (`src/writer/newplatform.ts`)

复制 `cursor.ts` 作为模板，修改平台名：
```typescript
export function generateNewPlatform(scan: ScanResult): ConvertResult { ... }
```

### 4. CLI 注册 (`src/index.ts`)

- `generateForPlatform()` 添加新 case
- `validPlatforms` 数组添加新值
- import 新 writer

### 5. TUI 注册 (`src/tui.ts`)

在 `selectPlatforms()` 的 choices 中添加新选项。

### 6. 测试

- 每个 converter 测试文件添加新平台的用例
- 新增 `src/__tests__/newplatform-writer.test.ts`（可选）

### 7. 文档

- 更新 README.md 和 README.zh-CN.md 的支持矩阵表格
- 更新 llmdoc/reference/conversion-matrix.md

## 降级策略参考

| 场景 | 推荐策略 |
|------|---------|
| 平台无 Agent 系统 | 降级为指令/规则文件 |
| 平台无 Hooks | 记录为文档 + 输出 warning |
| 平台 MCP 格式不同 | 做字段映射转换 |
| 平台无 Skills 概念 | 转为命令或规则文件 |
| Claude 特有字段 | 保留为 HTML 注释 |
