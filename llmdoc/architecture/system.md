# System Architecture

## 1. Identity

- **What it is:** A multi-stage pipeline: Source Resolution, Scanner, Converters, and Writers, with interactive TUI for plugin selection.
- **Purpose:** Transforms Claude Code plugin resources into platform-specific output files.

## 2. Core Components

- `src/index.ts` (`program`, `generateForPlatform`, `isGitHubSource`, `resolveSource`, `detectAndScan`): CLI entry point. Defines `scan` and `convert` commands. Auto-detects GitHub vs local source. Routes to marketplace, plugin, or project scan. Dispatches to platform-specific writers.
- `src/github.ts` (`parseGitHubSource`, `downloadGitHubRepo`, `cleanupTempDir`, `getTempRoot`): GitHub repo download without git clone. Parses `owner/repo`, `github:owner/repo#branch`, and full URLs. Downloads tarball via GitHub API, extracts to temp dir. Supports `GITHUB_TOKEN` env var for private repos.
- `src/tui.ts` (`selectPlugins`, `selectPlatforms`, `parseSelection`, `log`): Interactive checkbox selection via @inquirer/prompts. Falls back to select-all in non-TTY environments. Provides styled console output helpers via chalk.
- `src/types.ts` (`Skill`, `Instruction`, `MCPConfig`, `Agent`, `Command`, `Hooks`, `ScanResult`, `PluginMeta`, `PluginScanResult`, `ConvertResult`, `ConvertedFile`): Unified type definitions shared across all stages. `PluginMeta` includes `displayName`, `homepage`, `repository`, `license`, `keywords` optional fields for rich plugin metadata passthrough.
- `src/scanner/claude.ts` (`scanClaudeProject`): Scans a standard Claude Code project directory (`.claude/` layout). Returns a `ScanResult`.
- `src/scanner/plugin.ts` (`hasMarketplace`, `isSinglePlugin`, `scanMarketplace`, `scanPlugin`, `scanAllPlugins`, `countResources`): Scans Claude Code official plugin format. Handles `.claude-plugin/marketplace.json` (multi-plugin) and `.claude-plugin/plugin.json` (single plugin). Plugin resources live directly in plugin root (`skills/`, `agents/`, `commands/`, `hooks/`), not under `.claude/`.
- `src/converter/skill.ts`: Converts `Skill` objects to target platform format.
- `src/converter/instructions.ts`: Converts `Instruction` (CLAUDE.md, rules) to AGENTS.md or .mdc files.
- `src/converter/mcp.ts`: Converts `.mcp.json` servers to config.toml / opencode.json / .cursor/mcp.json.
- `src/converter/agent.ts` (`convertAgent`, `convertToCodex`, `convertToOpenCode`, `convertToCursor`, `convertToAntigravity`): Converts `.claude/agents/*.md` to platform-specific formats. Cursor outputs `.cursor/agents/*.md` with `name`, `description`, `model`, `readonly`. OpenCode outputs `.opencode/agents/*.md` with `mode: subagent`, `steps`, `permission` (edit/bash deny). Antigravity outputs `.gemini/agents/*.md` with tool-mapped `allowed-tools`.
- `src/converter/command.ts`: Converts `.claude/commands/*.md` to platform commands.
- `src/converter/hooks.ts` (`convertHooks`, `convertCursorHooks`, `CURSOR_EVENT_MAP`): Converts `settings.json` hooks with compatibility warnings for non-portable events. Cursor hooks use dedicated `convertCursorHooks()` path: maps PascalCase events to camelCase (`PostToolUse` → `postToolUse`), strips `${CLAUDE_PLUGIN_ROOT}` to relative paths, outputs `{ version: 1, hooks: {...} }` JSON at `hooks/hooks-cursor.json`.
- `src/writer/codex.ts` (`generateCodex`): Orchestrates all converters for Codex output.
- `src/writer/opencode.ts` (`generateOpenCode`): Orchestrates all converters for OpenCode output.
- `src/writer/cursor.ts` (`generateCursor`, `generatePluginJson`, `remapToPluginPath`): Orchestrates all converters for Cursor output. Generates `.cursor-plugin/plugin.json` manifest with auto-detected components from scan result. Plugin.json passes through `displayName`, `homepage`, `repository`, `license`, `keywords` from source `PluginMeta`. Includes `hooks` field pointing to `hooks/hooks-cursor.json` when hooks exist. Remaps all `.cursor/` output paths to plugin root layout (`skills/`, `agents/`, `commands/`, `rules/`, `mcp.json`). Compatible with Cursor Marketplace (v2.5+).
- `src/writer/antigravity.ts` (`generateAntigravity`): Orchestrates all converters for Antigravity (Google) output. Skills → `.agent/skills/`, Instructions → `GEMINI.md`, MCP → `.gemini/settings.json`, Agents → `.gemini/agents/*.md`, Commands → Skills.
- `src/utils/model.ts` (`mapModel`, `CODEX_MODEL_MAP`, `ANTIGRAVITY_MODEL_MAP`): Maps Claude model names to platform equivalents. Codex → `gpt-5.4`, Antigravity → `gemini-3-pro`/`gemini-3-flash`. OpenCode and Cursor pass models through unchanged.
- `src/utils/frontmatter.ts`: YAML frontmatter parse/stringify via gray-matter.
- `src/utils/toml.ts`: TOML serialization via @iarna/toml.
- `src/utils/fs.ts` (`writeFile`, `readFile`, `fileExists`): File system utilities with directory creation.
- `.github/workflows/acplugin.yml`: Repository CI workflow that runs `TokenRollAI/acplugin-action@v1` on Claude source changes in `main`.
- `.github/workflows/publish-npm.yml`: Release workflow. Triggers on `v*` tags, verifies the tag matches `package.json` version, runs install/build/test/package validation, then publishes to npm with GitHub Actions OIDC Trusted Publishing.

## 3. Execution Flow (LLM Retrieval Map)

- **1. CLI Parse:** User invokes `acplugin scan [source]` or `acplugin convert [source]`. Commander.js parses args in `src/index.ts:16-21`. Source is a positional argument defaulting to `.`.
- **2. Source Resolution:** `isGitHubSource()` at `src/index.ts:26-36` auto-detects GitHub sources. `resolveSource()` at `src/index.ts:41-53` either downloads via `src/github.ts:74-109` or resolves a local path. Cleanup callback is returned for temp dirs.
- **3. Detection & Scan:** `detectAndScan()` at `src/index.ts:58-69` checks for marketplace (`hasMarketplace`), single plugin (`isSinglePlugin`), or standard project, then calls the appropriate scanner.
- **4. Interactive Selection (convert only):** If `--to` not specified, `selectPlatforms()` from `src/tui.ts:39-56` prompts for platform selection. For marketplace repos without `--all`, `selectPlugins()` from `src/tui.ts:10-34` prompts for plugin selection.
- **5. Convert:** Each writer (e.g., `src/writer/codex.ts`) calls converter modules (`src/converter/*.ts`) for each resource type, collecting `ConvertedFile[]` and warnings.
- **6. Write:** `convertSingleScan()` at `src/index.ts:193-227` iterates over `ConvertedFile[]` and writes each to disk via `src/utils/fs.ts`, unless `--dry-run` is set.
- **7. Report:** `printConvertReport()` at `src/index.ts:288-303` outputs a summary of generated files and warnings.

## 4. Design Rationale

- **One-way conversion only:** Claude Code is the source of truth. Bidirectional sync would create conflict resolution complexity with no clear benefit.
- **HTML comment preservation:** Claude-specific frontmatter fields (e.g., `allowed-tools`, `effort`) are embedded as HTML comments in output so they are not lost but do not break target platforms.
- **Native subagent support:** All four platforms now support agents natively. Each writer generates platform-specific agent frontmatter fields (Cursor: `readonly`; OpenCode: `mode`, `steps`, `permission`; Antigravity: `allowed-tools` with tool name mapping).
- **Model mapping:** `src/utils/model.ts` centralizes Claude-to-platform model translation, defaulting to the platform's strongest model when no mapping exists.
- **Auto-detection over flags:** Source type (GitHub/local) and format (marketplace/plugin/project) are auto-detected to minimize required CLI arguments.
- **Non-TTY fallback:** TUI selection defaults to "all" when stdin is not a TTY, enabling CI/script usage without interactive prompts.
