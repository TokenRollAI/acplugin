# ADR-0001: Session close, deterministic inputs, and dev rebuild scope

- Status: Accepted
- Date: 2026-08-08
- Updated: 2026-08-14
- Applies to: Kernel v2, lifecycle API v1

## Context

Kernel v2 replaces shared lifecycle hooks with one private `PlatformSession` or `ExtensionSession` per build. A Session may hold resources that must be released on success, failure, or abort, while a managed commit must remain rollback-capable until all required Session cleanup succeeds.

Build output and schema-v2 reports must also remain deterministic and free of machine paths or secrets. The former lifecycle exposed an ambient environment snapshot and discussed a cross-run dev cache without defining serializable state, implementation fingerprints, replayable effects, or transaction semantics.

## Decision

1. Core creates one isolated Session for every initialized Platform and Extension and calls `close()` exactly once in reverse initialization order.
2. For committed builds, `close()` runs from the transaction's `afterSwap` window. A close failure records a `cleanup` diagnostic, rolls back the new output, and leaves `success=false` and `committed=false`.
3. For validate, inspect, failed builds, and aborted development Sessions, Core closes initialized integrations outside the commit with `committed=false`. Cleanup continues after an individual close failure and never replaces the first business failure in the close summary.
4. Integration lifecycle contexts do not receive ambient `process.env`. Functional config sees only `{ command, mode }`; isolated execution receives only an explicit caller-supplied environment through `ExecutionService`.
5. Core and official integrations must not introduce time, randomness, machine paths, temporary paths, or secret values into Assets or reports. Sanitization removes structured secrets, recognized credentials, and known physical roots; it does not rewrite arbitrary substrings using environment values.
6. `Project.dev()` performs a complete BuildSession for every coalesced change round and preserves the last successful output. Kernel v2 has no whole-execution or cross-run cache.
7. Any future cache requires a versioned fingerprint, serializable owner-scoped state and effects, complete dependency discovery, corruption recovery, and clean-build equivalence tests. Third-party integrations are uncacheable unless a future explicit contract says otherwise.

## Consequences

- A successful report cannot contain an error diagnostic.
- A failed cleanup cannot expose a partially committed target set.
- Development rebuilds keep lifecycle, dependency discovery, validation, and transaction behavior equivalent to clean builds.
- Integration authors cannot accidentally depend on an environment snapshot that the framework cannot audit.

## Rejected alternatives

- Closing after the transaction is no longer rollback-capable: this could leave new output with a failed build result.
- Returning a previous report on a dev cache hit: this skips lifecycle effects, dependency discovery, recovery, and current-output validation.
- Replacing every environment-value substring in diagnostics: unrelated values can corrupt stable protocol identities.
- Allowing cleanup failure to overwrite the first business failure: it hides the actionable cause and makes diagnostics order-dependent.

## Evidence

- `packages/core/src/lifecycle/build-session.ts`
- `packages/core/src/lifecycle/dev-session.ts`
- `packages/core/src/security/report-safety.ts`
- `packages/core/src/output/transaction.ts`
- `packages/core/src/contracts/` (`IntegrationCloseContext`, `ExecutionService`, `BuildReport`)
