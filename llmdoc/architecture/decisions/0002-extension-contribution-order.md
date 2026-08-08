# ADR-0002: Extension contribution order is configuration order

- Status: Accepted
- Date: 2026-08-08
- Applies to: lifecycle API v1

## Context

Platform Adapters run serially against one mutable Platform Draft. `getDocument()` returns the current document, including patches from earlier Extensions, while `patchDocument()` and `emitArtifact()` add owner-scoped contributions.

Add-only ownership prevents replacement and silent deep merge, but it does not make Adapter execution commutative. An Adapter can inspect an earlier contribution before choosing a different value. A synchronous owner-conflict exception can also be caught by Adapter code unless Core remembers that the contribution was rejected.

## Decision

1. The order of `extensions[]` in resolved configuration is the semantic Extension contribution order.
2. Adapters execute serially in that order and may observe contributions accepted from earlier Adapters through `getDocument()`.
3. Lifecycle API v1 does not add `order`, `enforce`, an Extension dependency graph, or parallel Adapter execution. Reordering the configuration is the explicit ordering mechanism.
4. Add-only and owner isolation remain mandatory. They constrain what each Adapter may change; they do not promise order-independent output.
5. A rejected `patchDocument()` or Artifact contribution makes the current Platform invalid even if Adapter code catches the immediate exception. Core owns the final validity decision.
6. Reports and tests describe configuration-order behavior directly. Documentation must not justify the absence of `order/enforce` by claiming that contributions commute.

## Consequences

- The current implementation model and official Adapters remain compatible.
- Third-party authors have one deterministic and inspectable ordering mechanism.
- Reordering Extensions can intentionally change output and must be treated as a configuration change.
- Same-extension-point conflicts fail rather than degrade into first-writer-wins.
- A future order-independent model would require every Adapter to read one pre-adapter snapshot, buffer declarative contributions, and let Core merge them centrally with order-independent diagnostics. That would be a new lifecycle API decision.

## Rejected alternatives

- Claiming add-only merge is naturally commutative: contradicted by `getDocument()` and first-writer ownership.
- Adding `enforce:'pre'|'post'`: introduces a second ordering vocabulary without solving data dependencies.
- Sorting Extensions by name: deterministic but silently ignores the user's configuration order and changes existing behavior.
- Pre-adapter snapshots in 1.0: requires a buffered contribution protocol and changes what current Adapters can observe.

## Evidence

- `packages/core/src/contracts.ts:266-283`
- `packages/core/src/documents.ts:198-236,305-325`
- `packages/core/src/lifecycle.ts:543-580`
- Specification §9.3 and §9.4
