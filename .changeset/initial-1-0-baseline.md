---
"@tokenroll/acplugin": patch
"@tokenroll/acplugin-platform-claude-code": patch
"@tokenroll/acplugin-platform-codex": patch
"@tokenroll/acplugin-platform-cursor": patch
"@tokenroll/acplugin-platform-antigravity": patch
"@tokenroll/acplugin-platform-opencode": patch
"@tokenroll/acplugin-platform-pi": patch
"@tokenroll/acplugin-extension-hooks": patch
"@tokenroll/acplugin-extension-mcp": patch
---

Promote the complete TokenRoll ACPlugin beta package ecosystem to the stable `0.0.1` release.

This release establishes the new `@tokenroll/*` package line after the coordinated `0.0.1-beta` cohort. It is not a patch-compatible continuation of the legacy `@disdjj/acplugin` converter.

### Framework and CLI

- Rebuild `@tokenroll/acplugin` as an ESM-only CLI and public framework SDK for Node 20 and later.
- Route `validate`, `inspect`, `build`, `dev`, and programmatic `runProject()` through one fixed Core lifecycle.
- Require explicitly installed and configured Platform instances instead of bundling or re-exporting official integrations from the main package.
- Add typed configuration, project initialization, deterministic reports, resilient dev watching, and an isolated lazy-loaded Migration subsystem.
- Preserve complete managed output through owner-aware Artifacts, candidate validation, transactional replacement, reverse `buildEnd`, and rollback.

### First-class Platform packages

- Publish Claude Code, Codex, Cursor, Antigravity, OpenCode, and Pi as six independent `@tokenroll/acplugin-platform-*` packages.
- Make each Platform depend only on the public `@tokenroll/acplugin` peer SDK and own its conversion, Documents, DeliveryUnits, compatibility reporting, distributions, and final validation.
- Support native resources where the target permits them and report every transform, degradation, omission, and unsupported capability explicitly.

### Hooks and MCP Extensions

- Publish `@tokenroll/acplugin-extension-hooks` with a platform-neutral author API, bounded semantic runner, single-build handler bundles, and six Platform adapters.
- Publish `@tokenroll/acplugin-extension-mcp` with portable HTTP and local stdio definitions, environment-name Secret references, license output, and real `initialize`/`tools/list` protocol smoke.
- Keep Extension contributions add-only and owner-isolated; conflicting Document owners or Artifact targets fail before output commit.

### Determinism, safety, and release verification

- Use locale-independent ordering and stable JSON/YAML/Markdown serialization across Components, Artifacts, diagnostics, reports, and Migration output.
- Reject unsafe output paths, symlinks, invalid modes, source-root escapes, case-insensitive collisions, and Unicode-normalization collisions.
- Prevent timestamps, temporary or absolute paths, raw errors, environment values, and credentials from entering stable output.
- Validate all nine packed public packages with publint, type-resolution checks, peer-range rewriting, ESM module-boundary inspection, third-party Platform interoperability, and clean-consumer builds.
- Add repository-level TypeScript 7, Vitest, lint, comment coverage, Node 20 consumer, and read-only verification workflows without enabling automatic npm publishing, tags, or GitHub Releases.

Documentation, generated TypeDoc API references, package READMEs, and the repository Playground now describe and exercise the same independent Platform/Extension package boundaries.
