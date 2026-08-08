# ADR-0001: Lifecycle completion, deterministic inputs, and cache scope

- Status: Accepted
- Date: 2026-08-08
- Applies to: ACPlugin 1.0

## Context

The managed-output transaction calls `buildEnd` after the new output has been swapped into place but while the previous output is still recoverable. A `buildEnd` failure therefore currently aborts the transaction and restores the previous complete output.

Lifecycle hooks also receive one frozen environment snapshot. Separately, report sanitization used every environment value as an unbounded substring replacement. That sanitizer could corrupt protocol identities such as `claude-code` when an unrelated environment value was `claude`.

The 1.0 specification mentioned a dev cache without defining serializable Extension state, implementation fingerprints, replayable side effects, or cache-aware transaction semantics. A whole-execution cache would skip observable lifecycle hooks and could return an old `committed` result without validating the current output directory.

## Decision

1. `buildEnd` remains part of the complete build transaction. A `buildEnd` error rolls back the new output and produces `success=false` and `committed=false`.
2. An error diagnostic can never coexist with `success=true`. `committed` reports whether the current invocation completed its managed commit, not whether a previous invocation once committed the same bytes.
3. `BuildStartContext.environment` and `BuildEndContext.environment` remain public lifecycle capabilities. Core captures one frozen snapshot for the invocation.
4. The captured environment snapshot is a deterministic input. Core and built-in implementations must not introduce undeclared time, randomness, paths, or Secret-value reads into artifacts or reports. Trusted project/config/Extension code remains responsible for any ambient state it intentionally observes.
5. Report sanitization removes structured secret fields, recognized credential forms, project/runtime roots, and temporary paths. It does not enumerate arbitrary environment values and replace matching substrings.
6. ACPlugin 1.0 does not implement a whole-execution or cross-run Core cache. The specification constrains a dev cache if one is implemented; it does not require one to exist.
7. A future cache requires an explicit versioned fingerprint, serializable values, replayable owner-scoped effects, complete dependency discovery, corruption handling, and clean-build equivalence tests. Third-party implementations are uncacheable by default unless they opt in to that future contract.

## Consequences

- Cleanup failure continues to preserve the last complete distribution.
- REDACT-1 can be fixed without silently removing lifecycle environment access.
- Irrelevant environment values no longer rewrite report content.
- Development rebuilds continue to execute the full lifecycle and transaction in 1.0.
- A later incremental system is an architectural feature rather than an invisible optimization around arbitrary third-party code.

## Rejected alternatives

- `success=true` with an error diagnostic: contradicts the diagnostic collector and CLI exit-code contract.
- Post-commit `buildEnd` with retained output: coherent only as `committed=true, success=false`, but changes the existing transaction contract without a 1.0 requirement.
- Replacing hook environment with an empty object: silently breaks a public context while trusted code can still observe global process state.
- Returning a previous `BuildResult` on a dev cache hit: skips hooks, dependency discovery, validation, transaction recovery, and current-output verification.

## Evidence

- `packages/core/src/lifecycle.ts:218-226,286-348,702-718`
- `packages/core/src/transaction.ts:383-413`
- `packages/core/src/contracts.ts:188-193,257-264`
- `packages/core/src/diagnostics.ts:17-79`
- `packages/core/src/reports.ts:108-133`
- Specification §9.4, §10.3, and §18
