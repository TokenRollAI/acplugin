# Conversion Matrix

This document summarizes which Claude Code resource types are supported by each target platform, the supported input formats, and source types.

## 1. Core Summary

acplugin converts six Claude Code resource types (skills, instructions, MCP configs, agents, commands, hooks) across three target platforms (Codex, OpenCode, Cursor). Not all resource types have native equivalents on every platform; unsupported types are either degraded (e.g., agents become instructions) or generate compatibility warnings (e.g., hooks). Input can be a standard Claude Code project, a single plugin, or a multi-plugin marketplace. Sources can be local paths or GitHub repositories.

## 2. Source of Truth

- **Type Definitions:** `src/types.ts` - All resource types (`Skill`, `Instruction`, `MCPConfig`, `Agent`, `Command`, `Hooks`), plugin types (`PluginMeta`, `PluginScanResult`), and result types (`ScanResult`, `ConvertResult`, `ConvertedFile`).
- **GitHub Source Resolution:** `src/github.ts` - Parsing and downloading GitHub repos. Supported formats: `owner/repo`, `github:owner/repo#branch`, full URLs.
- **Plugin Scanner:** `src/scanner/plugin.ts` - Plugin format detection and scanning. Marketplace: `.claude-plugin/marketplace.json`. Single plugin: `.claude-plugin/plugin.json`. Plugin layout: `skills/`, `agents/`, `commands/`, `hooks/` directly in plugin root.
- **Project Scanner:** `src/scanner/claude.ts` - Standard Claude Code project scanning (`.claude/` directory layout).
- **TUI Selection:** `src/tui.ts` - Interactive plugin and platform selection via @inquirer/prompts.
- **Skill Converter:** `src/converter/skill.ts` - Platform-specific skill conversion logic.
- **Instruction Converter:** `src/converter/instructions.ts` - CLAUDE.md / rules conversion to AGENTS.md or .mdc.
- **MCP Converter:** `src/converter/mcp.ts` - MCP server config conversion to config.toml / opencode.json / .cursor/mcp.json.
- **Agent Converter:** `src/converter/agent.ts` - Agent conversion with degradation to instructions when unsupported.
- **Command Converter:** `src/converter/command.ts` - Command conversion across platforms.
- **Hooks Converter:** `src/converter/hooks.ts` - Hook conversion with compatibility warnings for non-portable events.
- **Codex Writer:** `src/writer/codex.ts` - Codex output orchestration.
- **OpenCode Writer:** `src/writer/opencode.ts` - OpenCode output orchestration.
- **Cursor Writer:** `src/writer/cursor.ts` - Cursor output orchestration.
- **System Architecture:** `/llmdoc/architecture/system.md` - Full pipeline and execution flow.
