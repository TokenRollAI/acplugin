---
name: add-converter
description: Add or change a canonical acplugin Component and its Platform compilation, including schema, Resource discovery, compatibility, Package Assets, and tests. Use when adding a new authoring resource or changing how Commands, Skills, or Agents compile.
---

# Add a canonical Component

1. Decide whether the feature belongs in Core. Only cross-platform authoring concepts may become Components; optional horizontal capabilities belong in Extensions. Do not add Instructions as a Component.
2. Add canonical and author contracts in `packages/core/src/kernel-types.ts`. Keep Platform wire fields out of canonical types; use semantic fields and Platform-owned `platforms` metadata only where a verified capability requires it.
3. Update `packages/core/src/resources/canonical-provider.ts` and `project-graph.ts` with strict path, Frontmatter, identity, dependency, and symlink validation. Providers return normalized data and diagnostics, never Platform files.
4. Update every built-in Platform owner under `packages/platforms/<id>/`. Each Platform decides its own native representation or explicit transformation and owns its Manifest, output paths, serialization, and candidate validation.
5. For every Platform, report `native`, `transform`, `degraded`, or `unsupported`. Strict mode must fail on degraded/unsupported; relaxed mode must emit the explicit result and warning.
6. Create only Core-signed AssetRef values, then map them into Platform base/final Package or add-only Extension Contribution. Platform/Extension code receives no physical output or workDir authority and never writes `dist` directly.
7. Add Core schema/graph tests, per-Platform golden/schema tests, and cross-package strictness/collision tests under `packages/core/test/`, `packages/platforms/<id>/test/`, and `packages/test/test/`.
8. Update the six-Platform compatibility tables, `AGENTS.md`, package README files, and the affected `llmdoc/` references.

Run:

```bash
pnpm run lint
pnpm run typecheck
pnpm run test
pnpm run build
```

Preserve deterministic path ordering, stable diagnostics, transactional all-Platform behavior, and independent public Platform package/peer boundaries.
