# ADR-0002: Extension contributions are unordered and centrally merged

- Status: Accepted
- Date: 2026-08-08
- Updated: 2026-08-14
- Applies to: Kernel v2, lifecycle API v1

## Context

An Extension builds one Platform-independent immutable state and may publish a `PlatformContributor` for each supported Platform. If Contributors mutated a shared package or observed earlier contributions, configuration order would become an implicit dependency and conflict resolution would degrade into first-writer-wins behavior.

Kernel v2 instead needs independent integrations, parallel-safe collection, and deterministic conflicts.

## Decision

1. A Platform creates one frozen base Package. Every matching Framework and Extension Contributor reads that same base snapshot.
2. A Contributor cannot observe another Contribution, another Extension's state, or a mutable Package.
3. Core collects Extension Contributions concurrently, binds each one to its owner, sorts the collection by stable owner identity, and performs one centralized add-only merge.
4. Contributions may fill declared empty Document extension points, add owner-authorized Assets, and report compatibility. They cannot replace or delete base content, append to undeclared fields, claim Components, or override another owner.
5. Duplicate Document fields, Asset paths, compatibility tuples, or normalization-equivalent paths fail deterministically. Configuration order is not a conflict-resolution mechanism.
6. Lifecycle API v1 does not add `order`, `enforce`, an Extension dependency graph, cross-Extension state access, or claim/suppress protocols.

## Consequences

- Reordering independent Extensions does not change successful Package bytes.
- Contributor collection can run concurrently without changing semantics.
- Conflicts are explicit architecture errors rather than order-sensitive output.
- Features that truly require cooperation must be represented by a shared Framework contract or a Platform extension point, not hidden Extension sequencing.

## Rejected alternatives

- Serial mutation in configuration order: creates an undocumented dependency graph and observable partial state.
- `enforce: 'pre' | 'post'`: adds ordering vocabulary without defining safe data dependencies.
- Last-writer-wins merge: violates owner isolation and hides incompatible integrations.
- Direct Platform replacement or Component suppression: expands the authority model beyond additive integration.

## Evidence

- `packages/core/src/resources/extension-provider.ts`
- `packages/core/src/package/package-registry.ts`
- `packages/core/src/kernel/build-session.ts`
- `packages/core/src/kernel-types.ts` (`PlatformContributor`, `ContributionContext`, `PackageContribution`)
