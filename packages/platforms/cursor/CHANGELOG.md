# @tokenroll/acplugin-platform-cursor

## 0.0.3-beta

### Major Changes

- Add opaque, subject-bound Platform Component Contributions to the trusted Integration SDK. Core now transports strict JSON payloads and records scoped contributor provenance in BuildReport schema version 3 without acquiring Platform-specific Agent or target-format knowledge.

  Claude Code, Cursor, and OpenCode expose and render their own native Agent contribution payloads during Platform finalization. Codex, Antigravity, and Pi explicitly reject non-empty private component contributions rather than silently dropping them or generating fallback Skills.

  Harden `AssetService.fromBytes()` to accept only exact data-object inputs, exact generated-origin fields, and `string | Uint8Array` bytes so third-party Integrations cannot rely on accessor, hidden-field, or array-like coercion.

### Patch Changes

- Updated dependencies
  - @tokenroll/acplugin@0.0.3-beta

## 0.0.2-beta

### Major Changes

- 889da32: Rewrite the Cursor Platform around the Package API, Core-owned Document codecs, native Command/Skill/Agent Assets, add-only Hooks/MCP extension points, final candidate validation, and explicit unsupported Node Runtime compatibility.

### Patch Changes

- Updated peer dependency on `@tokenroll/acplugin` to `^0.0.2-beta`.
