---
name: add-platform
description: Add a new installable-plugin target to acplugin through a private Compiler and official Module adapters. Use when introducing another AI platform target or revising a target's current manifest, component, Hooks, or MCP contract.
---

# Add a target platform

1. Verify the current official installable-plugin contract. Record manifest path/schema, install root semantics, Component discovery, Hooks events/protocol, MCP transports/config, secret handling, and a real validation/install command. Do not confuse project overlays with installable plugins.
2. Add the target ID to Core contracts/config validation and CLI choices.
3. Create a private `packages/compiler-<target>/` package. The Compiler must:
   - compile every canonical Component;
   - own base/reserved Manifest fields;
   - emit deterministic Artifacts without filesystem side effects;
   - report complete compatibility and dependency propagation;
   - validate generated identities, references, paths, and collisions.
4. Bundle the private Compiler into `@tokenroll/acplugin`; it must not appear in the public package runtime manifest or packed imports.
5. Add target adapters to official Hooks/MCP Modules only for verified capabilities. Keep target protocol JSON out of author handlers/descriptors.
6. Register CLI/default-target behavior only after compatibility policy is defined. Do not silently expand the default target cohort.
7. Add golden fixtures, strict/relaxed cases, target schema checks, installed-cache path tests, Hook runtime tests, and MCP protocol smoke tests.
8. Update README, `AGENTS.md`, platform reference docs, tarball consumer verification, and release acceptance criteria.

Run the full repository and packed-consumer checks:

```bash
pnpm run check
pnpm run release:verify
```
