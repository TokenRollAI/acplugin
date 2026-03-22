---
name: add-converter
description: Add a new resource type converter to acplugin (e.g., adding support for converting a new Claude Code resource type)
---

# 添加新资源类型转换器

当需要支持转换新的 Claude Code 资源类型时，按以下步骤操作。

## 步骤

### 1. 定义类型 (`src/types.ts`)

添加新资源的接口定义和 frontmatter 类型（如果有），以及在 `ScanResult` 中添加字段。在 `ConvertedFile.type` 联合类型中添加新值。

### 2. 添加扫描函数 (`src/scanner/claude.ts`)

创建并导出可复用的扫描函数（如 `scanXxxDir()`），这样 `plugin.ts` 也能使用。

在 `scanClaudeProject()` 中调用新函数。

### 3. 集成 Plugin Scanner (`src/scanner/plugin.ts`)

在 `scanPlugin()` 中调用新扫描函数，注意 plugin 目录结构与 .claude/ 不同：
- 项目: `.claude/xxx/`
- Plugin: `xxx/`（直接在 plugin 根目录下）

更新 `countResources()` 包含新资源。

### 4. 创建 Converter (`src/converter/xxx.ts`)

实现 `convertXxx(item, platform)` 函数，处理三个平台：

```typescript
export function convertXxx(item: Xxx, platform: Platform): ConvertedFile {
  switch (platform) {
    case 'codex': return convertToCodex(item);
    case 'opencode': return convertToOpenCode(item);
    case 'cursor': return convertToCursor(item);
  }
}
```

**关键原则**：
- Converter 无副作用，只返回 `ConvertedFile`
- 不支持的功能用降级策略（合并到 AGENTS.md 或 rules）
- 返回 warnings 告知用户不兼容项

### 5. 集成 Writer (`src/writer/*.ts`)

在三个 writer 文件中调用新 converter，处理合并逻辑。

### 6. 更新 CLI 输出 (`src/index.ts`)

更新 `printScanResult()` 和 `convertSingleScan()` 中的资源计数。

### 7. 添加测试 (`src/__tests__/xxx.test.ts`)

为新 converter 创建测试，覆盖三个平台的转换逻辑。

### 8. 更新 test-fixture/

在 `test-fixture/` 中添加新资源类型的示例文件，确保 `scanner.test.ts` 覆盖。

## Frontmatter 解析容错

社区插件的 YAML 可能格式不规范。扫描函数中必须 try-catch `parseFrontmatter()`，解析失败时用空 frontmatter + 原始内容兜底。
