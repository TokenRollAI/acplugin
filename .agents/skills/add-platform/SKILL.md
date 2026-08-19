---
name: add-platform
description: Add a new acplugin Platform through an independent public package and official Extension Contributors. Use when introducing another AI platform or revising a Platform manifest, Component, Hooks, MCP, Package, Distribution, or compatibility contract.
---

# Add a Platform

1. Verify the current target contract from primary documentation. Record whether delivery is a static Plugin, workspace overlay, or package; then record schema/path/install-root semantics, Component discovery, Hooks events/protocol, MCP transports/config, secret handling, and a real validation/install command.
2. Create one independent public `packages/platforms/<id>/` package. It imports only `@tokenroll/acplugin/sdk`, declares the main package as a `workspace:^` peer, implements `definePlatform()`, and owns an accurate `deliveryType`.
3. Keep all target-specific behavior in that package:
   - validate Platform-specific Component fields;
   - compile every canonical Component and report complete compatibility;
   - own base Documents, extension points, Manifest fields, Package identity, and optional Distribution;
   - create only Core-signed AssetRef values without direct output writes;
   - validate identities, references, paths, tree closure, and the final materialized candidate.
4. Do not add a main-package re-export/subpath, Core Platform-ID branch, package registry, or official-only lifecycle path. The main package bundles private Core but never bundles an official Platform/Extension.
5. Add `PlatformContributor` implementations to Hooks/MCP only for verified capabilities. Every Contributor reads the same immutable base Package and returns an add-only Contribution; the Platform exposes controlled Document extension points and never imports an Extension.
6. Add the Platform to CLI selection, init metadata, ecosystem version snapshot, docs, and release verifier only after compatibility and empty-state behavior are defined. Do not silently expand the default Claude Code + Codex cohort.
7. Add package-owned golden/schema/candidate tests, strict/relaxed integration cases, real-consumer smoke appropriate to the delivery type, Hook runtime tests, MCP protocol tests, and owner/collision isolation.
8. Update the Platform matrices, `AGENTS.md`, package docs, TypeDoc entry set, tarball consumer verification, primary-source links, and contract verification date.

Run the full repository and packed-consumer checks:

```bash
pnpm run lint
pnpm run typecheck
pnpm run test
pnpm run build
pnpm run docs:check
pnpm run release:verify
```
