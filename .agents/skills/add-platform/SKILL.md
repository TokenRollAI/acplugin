---
name: add-platform
description: Add a new acplugin Platform through an independent private package and official Extension adapters. Use when introducing another AI platform or revising a Platform manifest, Component, Hooks, MCP, delivery-unit, or compatibility contract.
---

# Add a Platform

1. Verify the current official delivery contract from primary documentation. Record whether the output is a static Plugin, workspace overlay, or package; then record schema/path/install-root semantics, Component discovery, Hooks events/protocol, MCP transports/config, secret handling, and a real validation/install command.
2. Create one private `packages/platforms/<id>/` package. It must implement the branded Core Platform contract and declare an accurate `deliveryType`.
3. Keep all Platform-specific behavior in that package:
   - compile every canonical Component;
   - own base/reserved Documents and Manifest fields;
   - emit deterministic Artifacts without direct output writes;
   - report complete compatibility and metadata disposition;
   - validate generated identities, references, paths, collisions, and the final materialized candidate.
4. Export a thin factory from `packages/acplugin/src/platforms/<id>.ts` and the main facade, then bundle the private package into `@tokenroll/acplugin`. No private `@acplugin/*` runtime dependency or import may survive in the public tarball.
5. Add adapters to the official Hooks/MCP Extensions only for capabilities verified on this Platform. The Extension owns the Adapter; the Platform exposes only controlled Document extension points and never imports an Extension.
6. Add the Platform to CLI selection and `init` choices only after compatibility and empty-state behavior are defined. Do not silently expand the default Claude Code + Codex cohort.
7. Add package-owned golden/schema/candidate tests, strict/relaxed integration cases, installed-cache or real-consumer smoke tests appropriate to the delivery type, Hook runtime tests, and MCP protocol tests.
8. Update the six-or-more-Platform matrices, `AGENTS.md`, package docs, release tarball consumer verification, official links, and contract verification date.

Run the full repository and packed-consumer checks:

```bash
pnpm run check
pnpm run release:verify
```
