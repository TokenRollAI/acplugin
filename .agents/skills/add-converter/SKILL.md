---
name: add-converter
description: Add or change a canonical acplugin Component and its built-in Claude Code/Codex compilation, including schema, scanning, compatibility, Artifact output, and tests. Use when adding a new authoring resource or changing how Commands, Skills, or Agents compile.
---

# Add a canonical Component

1. Decide whether the feature belongs in Core. Cross-platform authoring concepts may become Components; optional or platform-specific capabilities should usually be Modules. Do not add Instructions as a Component.
2. Add canonical and resolved contracts in `packages/core/src/types.ts`. Keep target wire fields out of canonical types; use semantic fields plus explicit `extensions` only when required.
3. Update `packages/core/src/scanner.ts` with strict path, Frontmatter, identity, dependency, and symlink validation. Scanner returns normalized data and diagnostics, never target files.
4. Update both private Compilers:
   - `packages/compiler-claude-code/src/index.ts`
   - `packages/compiler-codex/src/index.ts`
5. For every target, declare `native`, `transform`, `degraded`, or `unsupported`. Strict mode must fail on degraded/unsupported; relaxed mode must emit the explicit result and warning.
6. Generate only `ArtifactInput` values. Compilers own reserved Manifest fields and final serialization; no direct filesystem writes.
7. Add Core schema/graph tests and private cross-package golden/strictness/collision tests under `packages/core/test/` and `packages/test/test/`.
8. Update README compatibility tables, `AGENTS.md`, and the affected `llmdoc/` reference.

Run:

```bash
pnpm run lint
pnpm run typecheck
pnpm run test
pnpm run build
```

Preserve deterministic path ordering, stable diagnostics, transactional all-target behavior, and private package bundling boundaries.
