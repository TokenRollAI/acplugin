# ADR-0004: Platforms are first-class ecosystem packages

- Status: accepted
- Date: 2026-08-08
- Scope: ACPlugin 1.0 package API

## Context

The six official Platforms were private `@acplugin/*` workspace packages bundled and re-exported by the main package. That model simplified single-tarball use, but gave official Platforms a private Core dependency unavailable to third parties and forced the framework package to know every official implementation. Extensions already demonstrate that an independently published package can use the public lifecycle SDK through a peer dependency while preserving ownership, branding, and lifecycle boundaries.

Making `@tokenroll/acplugin/platforms/<id>` an export subpath would still leave it owned and versioned by the main package rather than create an independent installation and publication boundary.

## Decision

1. `@tokenroll/acplugin` provides only the CLI and public framework SDK; it does not re-export official Platforms or Extensions.
2. Each official Platform is published as `@tokenroll/acplugin-platform-<id>`. The Extensions retain `@tokenroll/acplugin-extension-<name>`.
3. Every official integration imports only public contracts from `@tokenroll/acplugin/sdk` and declares the main package as a peer dependency. Production sources cannot import private Core.
4. `platforms` is required. The main package does not load official implementations by default or by ID. `init` preserves the default Claude Code and Codex experience by generating explicit dependencies and imports.
5. Official integrations are versioned independently; lifecycle `apiVersion` and the main-package peer range express compatibility.
6. Third-party packages need no registry, official scope, or enforced naming convention.
7. Version 1.0 keeps no compatibility re-export or Platform subpath.

## Consequences

- Projects install and import every selected Platform explicitly.
- Official Platforms become real examples that third-party authors can reproduce.
- The normal main-package runtime graph does not grow with the official Platform catalog.
- Release verification expands from three to nine tarballs and checks peer rewriting, brand interoperability, and a clean consumer.
- Init, Migration, fixtures, documentation, and release workflows must use the independent package names.

## Rejected alternatives

- Main-package `./platforms/*` subpaths: they retain one owner, version, and publication boundary.
- Deprecated re-exports: they preserve the wrong default and prevent a genuinely narrow framework package.
- Automatic package discovery or installation by Platform ID: it introduces network side effects and non-deterministic naming resolution.
- Publishing the private Core package: it leaks Registry and transaction internals instead of maintaining one public SDK boundary.

## Evidence

- `packages/acplugin/src/index.ts`
- `packages/acplugin/src/project.ts`
- `packages/acplugin/src/sdk.ts`
- `packages/acplugin/tsdown.config.ts`
- `packages/platforms/*/package.json`
- `packages/extensions/*/package.json`
- Specification §4.2–§4.4, §5.2, and §19
