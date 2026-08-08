# Domain glossary

These terms distinguish related outcomes and ordering rules in the ACPlugin lifecycle.

| Term | Definition |
|---|---|
| Build outcome | Whether the current invocation completed every required lifecycle phase without an error diagnostic or exception. Exposed as `BuildResult.success`. |
| Commit outcome | Whether the current invocation completed the managed output transaction. Exposed as `BuildResult.committed`; it is false for validate/inspect, failed/rolled-back commits, and invocations that never attempted a commit. |
| Cleanup outcome | The result of reverse-order `buildEnd` execution. In lifecycle API v1 it is not a separate public boolean: a cleanup failure is an error diagnostic, makes the build outcome fail, and rolls back a commit still in progress. |
| Deterministic input | Project bytes, resolved command/mode/config, Platform and Extension implementations/versions, Node major, lockfile, and the captured lifecycle environment snapshot. Trusted executable code is responsible for additional ambient state it intentionally reads. |
| Stable output | Artifact and report bytes/order that are identical for identical deterministic inputs. Stable output excludes timestamps, absolute/temporary paths, random identifiers, Secret values, and locale-dependent ordering. |
| Cacheable computation | A computation with a versioned complete fingerprint, serializable result, declared dependency closure, and replayable owner-scoped effects. Arbitrary lifecycle hooks are not cacheable merely because their Context is readonly. |
| Extension contribution order | The order of Extensions in resolved `extensions[]`. Adapters execute serially in this semantic order and may read earlier accepted Document contributions. |
| Current Draft | The Platform Draft after the Platform contribution and all previously accepted Adapter contributions in configuration order. It is what `getDocument()` observes. |
| Add-only contribution | A Document field or Artifact added at a declared empty extension point/path without replacing, removing, moving, appending to arrays, or implicitly deep-merging existing data. |
| Owner conflict | Two owners claim the same Document field or Artifact output path. It is a Core-enforced failure and cannot be converted to first-writer-wins by catching an Adapter exception. |

See ADR-0001 and ADR-0002 under `llmdoc/architecture/decisions/` for the accepted 1.0 semantics.
